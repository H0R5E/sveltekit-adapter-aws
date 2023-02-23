import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { config } from 'dotenv';

const serverPath = process.env.SERVER_PATH;
const projectPath = process.env.PROJECT_PATH;
const environment = config({ path: projectPath });
const memorySize = parseInt(process.env.MEMORY_SIZE!) || 128;

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

// exports.url = counterTable.url;
