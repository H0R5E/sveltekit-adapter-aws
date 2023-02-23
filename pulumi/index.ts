import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { config } from 'dotenv';

function get_domain_and_subdomain(domain: string) {
    
  var parts = domain.split(".");
  
  if (parts.length < 2) {
      throw new Error(`No TLD found on ${domain}`);
  }
  
  if (parts.length == 2) {
    return ['', domain] as const;
  }
  
  const subdomain = parts[0];
  parts.shift();
  
  return [subdomain, parts.join('.') + '.'] as const;
  
}

const serverPath = process.env.SERVER_PATH;
const projectPath = process.env.PROJECT_PATH;
const environment = config({ path: projectPath });
const memorySize = parseInt(process.env.MEMORY_SIZE!) || 128;
const [_, zoneName, ...MLDs] = process.env.FQDN?.split('.') || [];
const domainName = [zoneName, ...MLDs].join(".");

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
    
    const [subdomain,
           parent_domain] = get_domain_and_subdomain(process.env.FQDN!)
    
    const hostedZone = aws.route53.getZone({
            name: parent_domain,
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
    Name: "My bucket",
    forceDestroy: "true",
}});

const bAcl = new aws.s3.BucketAclV2("bAcl", {
    bucket: bucket.id,
    acl: "private",
});


const originRequestPolicy = new aws.cloudfront.OriginRequestPolicy(
    "OriginRequestPolicy", {
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


const distribution = new aws.cloudfront.Distribution(
    "CloudFrontDistribution", {
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
        originRequestPolicyId: originRequestPolicy.id,
        targetOriginId: "bob"
    },
    origins: [{
        domainName: bucketV2.bucketRegionalDomainName,
        originAccessControlId: aws_cloudfront_origin_access_control["default"].id,
        originId: s3OriginId,
    }],
    isIpv6Enabled: true,
    comment: "Some comment",
    loggingConfig: {
        includeCookies: false,
        bucket: "mylogs.s3.amazonaws.com",
        prefix: "myprefix",
    },
    aliases: [
        "mysite.example.com",
        "yoursite.example.com",
    ],
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
});

// exports.url = counterTable.url;
