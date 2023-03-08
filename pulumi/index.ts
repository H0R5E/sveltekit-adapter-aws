// Copyright 2016-2019, Pulumi Corporation.  All rights reserved. (Apache 2.0)
// Modifications copyright (C) 2023 Mathew Topper

import * as fs from 'fs';
import * as mime from 'mime';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { config, DotenvConfigOutput } from 'dotenv';
import { local } from '@pulumi/command';
import { hashElement } from 'folder-hash';
import { assign, keys, pick } from 'lodash';

const serverPath = process.env.SERVER_PATH;
const projectPath = process.env.PROJECT_PATH;
const memorySize = parseInt(process.env.MEMORY_SIZE!) || 128;
const [_, zoneName, ...MLDs] = process.env.FQDN?.split('.') || [];
const domainName = [zoneName, ...MLDs].join('.');
const staticPath = process.env.STATIC_PATH;
const prerenderedPath = process.env.PRERENDERED_PATH;
const routes = process.env.ROUTES?.split(',') || [];

const dotenv = config({ path: projectPath });
const parsed = assign({}, dotenv.parsed, pick(process.env, keys(dotenv.parsed)));
const environment = { parsed: parsed } as DotenvConfigOutput;

// Sync the contents of the source directory with the S3 bucket, which will
// in-turn show up on the CDN.
function uploadStatic(path: string, bucket: aws.s3.Bucket) {
  // crawlDirectory recursive crawls the provided directory, applying the
  // provided function to every file it contains. Doesn't handle cycles from
  // symlinks.
  function crawlDirectory(dir: string, f: (_: string) => void) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = `${dir}/${file}`;
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        crawlDirectory(filePath, f);
      }
      if (stat.isFile()) {
        f(filePath);
      }
    }
  }

  console.log('Syncing contents from local disk at', path);
  crawlDirectory(path, (filePath: string) => {
    const relativeFilePath = filePath.replace(path + '/', '');
    const contentFile = new aws.s3.BucketObject(
      relativeFilePath,
      {
        key: relativeFilePath,
        bucket: bucket.id,
        contentType: mime.getType(filePath) || undefined,
        source: new pulumi.asset.FileAsset(filePath),
      },
      {
        parent: bucket,
      }
    );
  });
}

const optimizedCachePolicy = aws.cloudfront.getCachePolicyOutput({
  name: 'Managed-CachingOptimized',
});

const disabledCachePolicy = aws.cloudfront.getCachePolicyOutput({
  name: 'Managed-CachingDisabled',
});

function buildBehavior(route: string) {
  return {
    pathPattern: route,
    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
    cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
    targetOriginId: 's3Origin',
    originRequestPolicyId: routeRequestPolicy.id,
    cachePolicyId: optimizedCachePolicy.apply((policy) => policy.id!),
    viewerProtocolPolicy: 'redirect-to-https',
  };
}

// Creates a new Route53 DNS record pointing the domain to the CloudFront
// distribution.
function createAliasRecord(targetDomain: string, distribution: aws.cloudfront.Distribution): aws.route53.Record {
  // Split a domain name into its subdomain and parent domain names.
  // e.g. "www.example.com" => "www", "example.com".
  function getDomainAndSubdomain(domain: string): { subdomain: string; parentDomain: string } {
    const parts = domain.split('.');
    if (parts.length < 2) {
      throw new Error(`No TLD found on ${domain}`);
    }
    // No subdomain, e.g. awesome-website.com.
    if (parts.length === 2) {
      return { subdomain: '', parentDomain: domain };
    }
    const subdomain = parts[0];
    parts.shift(); // Drop first element.
    return {
      subdomain,
      // Trailing "." to canonicalize domain.
      parentDomain: parts.join('.') + '.',
    };
  }

  const domainParts = getDomainAndSubdomain(targetDomain);
  const hostedZoneId = aws.route53
    .getZone({ name: domainParts.parentDomain }, { async: true })
    .then((zone) => zone.zoneId);
  return new aws.route53.Record(targetDomain, {
    name: domainParts.subdomain,
    zoneId: hostedZoneId,
    type: 'A',
    aliases: [
      {
        name: distribution.domainName,
        zoneId: distribution.hostedZoneId,
        evaluateTargetHealth: true,
      },
    ],
  });
}

const iamForLambda = new aws.iam.Role('IamForLambda', {
  assumeRolePolicy: `{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Action": "sts:AssumeRole",
        "Principal": {
          "Service": "lambda.amazonaws.com"
        },
        "Effect": "Allow",
        "Sid": ""
      }
    ]
  }
  `,
});

const RPA = new aws.iam.RolePolicyAttachment("ServerRPABasicExecutionRole", {
  role: iamForLambda.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole
});

const serverHandler = new aws.lambda.Function('LambdaServerFunctionHandler', {
  code: new pulumi.asset.FileArchive(serverPath!),
  role: iamForLambda.arn,
  handler: 'index.handler',
  runtime: 'nodejs16.x',
  timeout: 900,
  memorySize: memorySize,
  environment: {
    variables: {
      ...environment.parsed,
    } as any,
  },
});

const httpApi = new aws.apigatewayv2.Api('API', {
  protocolType: 'HTTP',
});

const serverPermission = new aws.lambda.Permission(
  'ServerPermission',
  {
    action: 'lambda:InvokeFunction',
    principal: 'apigateway.amazonaws.com',
    function: serverHandler,
    sourceArn: pulumi.interpolate`${httpApi.executionArn}/*/*`,
  },
  { dependsOn: [httpApi, serverHandler] }
);

const serverIntegration = new aws.apigatewayv2.Integration('ServerIntegration', {
  apiId: httpApi.id,
  integrationType: 'AWS_PROXY',
  integrationUri: serverHandler.arn,
  integrationMethod: 'POST',
  payloadFormatVersion: '1.0',
});

const defaultRoute = new aws.apigatewayv2.Route('DefaultRoute', {
  apiId: httpApi.id,
  routeKey: '$default',
  target: pulumi.interpolate`integrations/${serverIntegration.id}`,
}, { dependsOn: [serverIntegration] });

let certificateArn: pulumi.Input<string> = '';

if (process.env.FQDN) {
  let eastRegion = new aws.Provider('east', { region: 'us-east-1' });

  const certificate = new aws.acm.Certificate(
    'Certificate',
    {
      domainName: process.env.FQDN!,
      validationMethod: 'DNS',
    },
    { provider: eastRegion }
  );

  const hostedZone = aws.route53.getZone({
    name: domainName,
    privateZone: false,
  });

  const certValidation = new aws.route53.Record(`${process.env.FQDN!}.validation`, {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    records: [certificate.domainValidationOptions[0].resourceRecordValue],
    ttl: 60,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    zoneId: hostedZone.then((x) => x.zoneId),
  });

  const certificateValidation = new aws.acm.CertificateValidation(
    'CertificateValidation',
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [certValidation.fqdn],
    },
    { provider: eastRegion }
  );

  certificateArn = certificateValidation.certificateArn;
}

const bucket = new aws.s3.Bucket('StaticContentBucket', {
  acl: 'private',
  forceDestroy: true,
});

uploadStatic(staticPath!, bucket);
uploadStatic(prerenderedPath!, bucket);

const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity('OriginAccessIdentity', {
  comment: 'this is needed to setup s3 polices and make s3 not public.',
});

const defaultRequestPolicy = new aws.cloudfront.OriginRequestPolicy('DefaultRequestPolicy', {
  cookiesConfig: {
    cookieBehavior: 'all',
  },
  headersConfig: {
    headerBehavior: 'whitelist',
    headers: {
      items: [
        'Origin',
        'Accept-Charset',
        'Accept',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers',
        'Referer',
        'Accept-Language',
        'Accept-Datetime',
        'X-Auth-Return-Redirect'
      ],
    },
  },
  queryStringsConfig: {
    queryStringBehavior: 'all',
  },
});

const routeRequestPolicy = new aws.cloudfront.OriginRequestPolicy('RouteRequestPolicy', {
  cookiesConfig: {
    cookieBehavior: 'none',
  },
  headersConfig: {
    headerBehavior: 'whitelist',
    headers: {
      items: ['User-Agent', 'Referer'],
    },
  },
  queryStringsConfig: {
    queryStringBehavior: 'none',
  },
});

const oac = new aws.cloudfront.OriginAccessControl('CloudFrontOriginAccessControl', {
  description: 'Default Origin Access Control',
  name: 'CloudFrontOriginAccessControl',
  originAccessControlOriginType: 's3',
  signingBehavior: 'always',
  signingProtocol: 'sigv4',
});

const distribution = new aws.cloudfront.Distribution('CloudFrontDistribution', {
  origins: [
    {
      originId: 'httpOrigin',
      domainName: httpApi.apiEndpoint.apply((endpoint) => endpoint.split('://')[1]),
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: 'https-only',
        originSslProtocols: ['SSLv3', 'TLSv1', 'TLSv1.1', 'TLSv1.2'],
      },
    },
    {
      originId: 's3Origin',
      domainName: bucket.bucketRegionalDomainName,
      originAccessControlId: oac.id,
    },
  ],
  aliases: process.env.FQDN ? [process.env.FQDN] : undefined,
  priceClass: 'PriceClass_100',
  enabled: true,
  viewerCertificate: process.env.FQDN
    ? {
        // Per AWS, ACM certificate must be in the us-east-1 region.
        acmCertificateArn: certificateArn,
        sslSupportMethod: 'sni-only',
      }
    : {
        cloudfrontDefaultCertificate: true,
      },
  defaultCacheBehavior: {
    compress: true,
    viewerProtocolPolicy: 'redirect-to-https',
    allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    cachedMethods: ['GET', 'HEAD'],
    originRequestPolicyId: defaultRequestPolicy.id,
    cachePolicyId: disabledCachePolicy.apply((policy) => policy.id!),
    targetOriginId: 'httpOrigin',
  },
  orderedCacheBehaviors: routes.map(buildBehavior),
  restrictions: {
    geoRestriction: {
      restrictionType: 'none',
    },
  },
});

const cloudFrontPolicyDocument = aws.iam.getPolicyDocumentOutput({
  statements: [
    {
      principals: [
        {
          type: 'Service',
          identifiers: ['cloudfront.amazonaws.com'],
        },
      ],
      actions: ['s3:GetObject'],
      resources: [pulumi.interpolate`${bucket.arn}/\*`],
      conditions: [
        {
          test: 'StringEquals',
          variable: 'AWS:SourceArn',
          values: [distribution.arn],
        },
      ],
    },
    {
      principals: [
        {
          type: 'AWS',
          identifiers: ['*'],
        },
      ],
      actions: ['s3:*'],
      resources: [pulumi.interpolate`${bucket.arn}/\*`, bucket.arn],
      conditions: [
        {
          test: 'Bool',
          variable: 'aws:SecureTransport',
          values: ['false'],
        },
      ],
    },
  ],
});

const cloudFrontBucketPolicy = new aws.s3.BucketPolicy('CloudFrontBucketPolicy', {
  bucket: bucket.id,
  policy: cloudFrontPolicyDocument.apply((policy) => policy.json),
});

if (process.env.FQDN) {
  const aRecord = createAliasRecord(process.env.FQDN, distribution);
}

var allowedOrigins: (string | pulumi.Output<string>)[] = [pulumi.interpolate`https://${distribution.domainName}`];
process.env.FQDN && allowedOrigins.push(`https://${process.env.FQDN}`);

const optionsHandler = new aws.lambda.Function('OptionsLambda', {
  role: iamForLambda.arn,
  handler: "index.handler",
  runtime: 'nodejs16.x',
  code: new pulumi.asset.AssetArchive({
      "index.js": pulumi.all(allowedOrigins).apply((x) => {return new pulumi.asset.StringAsset(
`exports.handler = async(event) => {
  const allowedOrigins = ${JSON.stringify(x)};
  var headers = {'Access-Control-Allow-Methods': '*',
                 'Access-Control-Allow-Headers': '*',
                 'Access-Control-Max-Age': 86400,
                 'Connection': 'keep-alive'};
  if (allowedOrigins.includes(event.headers.origin)) {
    headers['Access-Control-Allow-Origin'] = event.headers.origin;
  }
  const response = {
    statusCode: 204,
    headers: headers,
  };
  return response;
  }`)}),
  })
});

const optionsPermission = new aws.lambda.Permission(
  'OptionsPermission',
  {
    action: 'lambda:InvokeFunction',
    principal: 'apigateway.amazonaws.com',
    function: optionsHandler,
    sourceArn: pulumi.interpolate`${httpApi.executionArn}/*/*`,
  },
  { dependsOn: [httpApi, optionsHandler] }
);

const optionsIntegration = new aws.apigatewayv2.Integration('OptionsIntegration', {
  apiId: httpApi.id,
  integrationType: 'AWS_PROXY',
  integrationUri: optionsHandler.arn,
  integrationMethod: 'POST',
  payloadFormatVersion: '1.0',
});

const optionsRoute = new aws.apigatewayv2.Route('OptionsRoute', {
  apiId: httpApi.id,
  routeKey: 'OPTIONS /{proxy+}',
  target: pulumi.interpolate`integrations/${optionsIntegration.id}`,
}, { dependsOn: [optionsIntegration] });

const stage = new aws.apigatewayv2.Stage('ApiStage', {
  name: '$default',
  apiId: httpApi.id,
  autoDeploy: true
}, { dependsOn: [defaultRoute, optionsRoute] });

export interface PathHashResourceInputs {
  path: pulumi.Input<string>;
}

interface PathHashInputs {
  path: string;
}

interface PathHashOutputs {
  hash: string;
}

const pathHashProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: PathHashInputs) {
      const pathHash = await hashElement(inputs.path);
      return { id: inputs.path, 
               outs: {hash: pathHash.toString()}};
  },
  async diff(id: string,
             previousOutput: PathHashOutputs,
             news: PathHashInputs): Promise<pulumi.dynamic.DiffResult> {
      
      const replaces: string[] = [];
      let changes = true;

      const oldHash = previousOutput.hash;
      const newHash = await hashElement(news.path);

      if (oldHash === newHash.toString()) {
          changes = false;
      }
      
      return {
          deleteBeforeReplace: false,
          replaces: replaces,
          changes: changes,
      };
  },
  async update(id, olds: PathHashInputs, news: PathHashInputs) {
      const pathHash = await hashElement(news.path);
      return { outs: {hash: pathHash.toString()} };
  }
}

export class PathHash extends pulumi.dynamic.Resource {
  public readonly hash!: pulumi.Output<string>;
  constructor(name: string,
              args: PathHashResourceInputs,
              opts?: pulumi.CustomResourceOptions) {
      super(pathHashProvider, name, { hash: undefined, ...args }, opts);
  }
}

let staticHash = new PathHash("StaticHash", {
  path: staticPath!
});

let prerenderedHash = new PathHash("PrerenderedHash", {
  path: prerenderedPath!
});

const invalidationCommand = new local.Command(
  'Invalidate',
  {
    create: pulumi.interpolate`aws cloudfront create-invalidation --distribution-id ${distribution.id} --paths /\*`,
    triggers: [staticHash.hash, prerenderedHash.hash],
  },
  {
    dependsOn: [distribution],
  }
);

exports.appUrl = process.env.FQDN
  ? `https://${process.env.FQDN}`
  : pulumi.interpolate`https://${distribution.domainName}`;
