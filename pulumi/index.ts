// Copyright 2016-2019, Pulumi Corporation.  All rights reserved. (Apache 2.0)
// Modifications copyright (C) 2023 Mathew Topper

import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { config } from 'dotenv';
import { local } from "@pulumi/command";

const serverPath = process.env.SERVER_PATH;
const projectPath = process.env.PROJECT_PATH;
const environment = config({ path: projectPath });
const memorySize = parseInt(process.env.MEMORY_SIZE!) || 128;
const [_, zoneName, ...MLDs] = process.env.FQDN?.split('.') || [];
const domainName = [zoneName, ...MLDs].join(".");
const staticPath = process.env.STATIC_PATH;
const prerenderedPath = process.env.PRERENDERED_PATH;
const routes = process.env.ROUTES?.split(',') || [];

const iamForLambda = new aws.iam.Role("iamForLambda", {assumeRolePolicy: `{
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
  `});

const serverHandler = new aws.lambda.Function("LambdaServerFunctionHandler", {
    code: new pulumi.asset.FileArchive(serverPath!),
    role: iamForLambda.arn,
    handler: "index.handler",
    runtime: "nodejs16.x",
    timeout: 900,
    memorySize: memorySize,
    environment: {
        ...environment.parsed,
      } as any}
);

const httpApi = new aws.apigatewayv2.Api("API", {
    protocolType: "HTTP",
    corsConfiguration: {
        allowHeaders: ['*'],
        allowMethods: ['*'],
        allowOrigins: ['*'],
        maxAge: 86400,
    }
});

const lambdaPermission = new aws.lambda.Permission("lambdaPermission", {
    action: "lambda:InvokeFunction",
    principal: "apigateway.amazonaws.com",
    function: serverHandler,
    sourceArn: pulumi.interpolate`${httpApi.executionArn}/*/*`,
}, {dependsOn: [httpApi, serverHandler]});

const integration = new aws.apigatewayv2.Integration("lambdaIntegration", {
    apiId: httpApi.id,
    integrationType: "AWS_PROXY",
    integrationUri: serverHandler.arn,
    integrationMethod: "POST",
    payloadFormatVersion: "1.0"
});

const route = new aws.apigatewayv2.Route("apiRoute", {
    apiId: httpApi.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
});

let certificateArn: pulumi.Input<string> = "";

if (process.env.FQDN) {
    
    let eastRegion = new aws.Provider("east", { region: "us-east-1" });
    
    const certificate = new aws.acm.Certificate('certificate', {
        domainName: process.env.FQDN!,
        validationMethod: 'DNS'},
        { provider: eastRegion });
    
    const hostedZone = aws.route53.getZone({
            name: domainName,
            privateZone: false,
        });
    
    const certValidation  = new aws.route53.Record(
        `${process.env.FQDN!}-validation`, {
            name: certificate.domainValidationOptions[0].resourceRecordName,
            records: [
                certificate.domainValidationOptions[0].resourceRecordValue],
            ttl: 60,
            type: certificate.domainValidationOptions[0].resourceRecordType,
            zoneId: hostedZone.then(x => x.zoneId),
        });
    
    const certificateValidation = new aws.acm.CertificateValidation( 
    "certificateValidation", {
        certificateArn: certificate.arn,
        validationRecordFqdns: [certValidation.fqdn],
    }, { provider: eastRegion });
    
    certificateArn = certificateValidation.certificateArn;
    
}

const bucket = new aws.s3.BucketV2("StaticContentBucket", {tags: {
    forceDestroy: "true",
}});

const bAcl = new aws.s3.BucketAclV2("bAcl", {
    bucket: bucket.id,
    acl: "private",
});

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

// Sync the contents of the source directory with the S3 bucket, which will 
// in-turn show up on the CDN.
const webContentsRootPath = path.join(process.cwd(), config.pathToWebsiteContents);
console.log("Syncing contents from local disk at", webContentsRootPath);
crawlDirectory(
    webContentsRootPath,
    (filePath: string) => {
        const relativeFilePath = filePath.replace(webContentsRootPath + "/", "");
        const contentFile = new aws.s3.BucketObjectv2(
            relativeFilePath,
            {
                key: relativeFilePath,
                acl: "public-read",
                bucket: bucket.id,
                contentType: mime.getType(filePath) || undefined,
                source: new pulumi.asset.FileAsset(filePath),
            },
            {
                parent: bucket,
            });
    });

const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity(
    "OriginAccessIdentity", {
    comment: "this is needed to setup s3 polices and make s3 not public.",
});

const defaultRequestPolicy = new aws.cloudfront.OriginRequestPolicy(
    "DefaultRequestPolicy", {
    cookiesConfig: {
        cookieBehavior: "all",
    },
    headersConfig: {
        headerBehavior: "whitelist",
        headers: {
            items: [
                'Origin',
                'Accept-Charset',
                'Accept',
                'Access-Control-Request-Method',
                'Access-Control-Request-Headers',
                'Referer',
                'Accept-Language',
                'Accept-Datetime'],
        },
    },
    queryStringsConfig: {
        queryStringBehavior: "all",
    },
});


const routeRequestPolicy = new aws.cloudfront.OriginRequestPolicy(
    "RouteRequestPolicy", {
    cookiesConfig: {
        cookieBehavior: "none",
    },
    headersConfig: {
        headerBehavior: "whitelist",
        headers: {
            items: [
                'User-Agent',
                'Referer'],
        },
    },
    queryStringsConfig: {
        queryStringBehavior: "none",
    },
});


function buildBehavior(route: string) {
    return {
        pathPattern: route,
        allowedMethods: [
            "GET",
            "HEAD",
            "OPTIONS",
        ],
        cachedMethods: [
            "GET",
            "HEAD",
            "OPTIONS",
        ],
        targetOriginId: "s3Origin",
        originRequestPolicyId: routeRequestPolicy.id,
        viewerProtocolPolicy: "redirect-to-https",
    }
}

const distribution = new aws.cloudfront.Distribution(
    "CloudFrontDistribution", {
    origins: [{
        originId: "httpOrigin",
        domainName: httpApi.apiEndpoint.apply(
            endpoint => endpoint.split('://')[1]),
        customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "https-only",
            originSslProtocols: ["SSLv3", "TLSv1", "TLSv1.1", "TLSv1.2"]
        },
    },
    {
        originId: "s3Origin",
        domainName: bucket.bucketRegionalDomainName,
        s3OriginConfig: {
            originAccessIdentity: originAccessIdentity.cloudfrontAccessIdentityPath,
        },
    }],
    priceClass: "PriceClass_100",
    enabled: true,
    defaultRootObject: "",
    viewerCertificate: process.env.FQDN
    ? {
        acmCertificateArn: certificateArn,  // Per AWS, ACM certificate must be in the us-east-1 region.
        sslSupportMethod: "sni-only",
    } : {
        cloudfrontDefaultCertificate: true,
    },
    defaultCacheBehavior: {
        compress: true,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: [
            "DELETE",
            "GET",
            "HEAD",
            "OPTIONS",
            "PATCH",
            "POST",
            "PUT",
        ],
        cachedMethods: [],
        originRequestPolicyId: defaultRequestPolicy.id,
        targetOriginId: "httpOrigin"
    },
    orderedCacheBehaviors: routes.map(buildBehavior),
    isIpv6Enabled: true,
    comment: "Some comment",
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
});

// Split a domain name into its subdomain and parent domain names.
// e.g. "www.example.com" => "www", "example.com".
function getDomainAndSubdomain(domain: string): { subdomain: string, parentDomain: string } {
    const parts = domain.split(".");
    if (parts.length < 2) {
        throw new Error(`No TLD found on ${domain}`);
    }
    // No subdomain, e.g. awesome-website.com.
    if (parts.length === 2) {
        return { subdomain: "", parentDomain: domain };
    }

    const subdomain = parts[0];
    parts.shift();  // Drop first element.
    return {
        subdomain,
        // Trailing "." to canonicalize domain.
        parentDomain: parts.join(".") + ".",
    };
}

// Creates a new Route53 DNS record pointing the domain to the CloudFront distribution.
function createAliasRecord(
        targetDomain: string,
        distribution: aws.cloudfront.Distribution): aws.route53.Record {
    const domainParts = getDomainAndSubdomain(targetDomain);
    const hostedZoneId = aws.route53.getZone(
        {name: domainParts.parentDomain},
        {async: true}).then(zone => zone.zoneId);
    return new aws.route53.Record(
        targetDomain,
        {
            name: domainParts.subdomain,
            zoneId: hostedZoneId,
            type: "A",
            aliases: [
                {
                    name: distribution.domainName,
                    zoneId: distribution.hostedZoneId,
                    evaluateTargetHealth: true,
                },
            ],
        });
}

if (process.env.FQDN) {
    const aRecord = createAliasRecord(process.env.FQDN, distribution);
}

invalidationCommand = new local.Command("invalidate", {
    create: pulumi.interpolate`aws cloudfront create-invalidation --distribution-id ${distribution.id} --paths '/*'`
    environment: {
      ETAG: indexFile.etag
    }
  }, {
      replaceOnChanges: ["environment"]
  });

// exports.url = counterTable.url;
