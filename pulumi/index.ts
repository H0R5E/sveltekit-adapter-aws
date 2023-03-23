import * as pulumi from '@pulumi/pulumi';
import { config, DotenvConfigOutput } from 'dotenv';
import { assign, keys, pick } from 'lodash';

import {
  getLambdaRole,
  buildServer,
  validateCertificate,
  buildStatic,
  buildCDN,
  createAliasRecord,
  buildServerOptionsHandler,
  deployServer,
  buildInvalidator,
} from './resources';

const serverPath = process.env.SERVER_PATH!;
const projectPath = process.env.PROJECT_PATH!;
const staticPath = process.env.STATIC_PATH!;
const prerenderedPath = process.env.PRERENDERED_PATH!;
const memorySize = parseInt(process.env.MEMORY_SIZE!) || 128;
const [_, zoneName, ...MLDs] = process.env.FQDN?.split('.') || [];
const domainName = [zoneName, ...MLDs].join('.');
const routes = process.env.ROUTES?.split(',') || [];

const dotenv = config({ path: projectPath });
const parsed = assign({}, dotenv.parsed, pick(process.env, keys(dotenv.parsed)));
const environment = { parsed: parsed } as DotenvConfigOutput;

const iamForLambda = getLambdaRole();
const { httpApi, defaultRoute } = buildServer(iamForLambda, serverPath, memorySize, environment);

let certificateArn: pulumi.Input<string> | undefined;

if (process.env.FQDN) {
  certificateArn = validateCertificate(process.env.FQDN, domainName);
}

const bucket = buildStatic(staticPath, prerenderedPath);
const distribution = buildCDN(httpApi, bucket, routes, process.env.FQDN, certificateArn);

if (process.env.FQDN) {
  createAliasRecord(process.env.FQDN, distribution);
}

var allowedOrigins: (string | pulumi.Output<string>)[] = [pulumi.interpolate`https://${distribution.domainName}`];
process.env.FQDN && allowedOrigins.push(`https://${process.env.FQDN}`);

const optionsRoute = buildServerOptionsHandler(iamForLambda, httpApi, allowedOrigins);
deployServer(httpApi, [defaultRoute, optionsRoute]);
buildInvalidator(distribution, staticPath, prerenderedPath);

exports.appUrl = process.env.FQDN
  ? `https://${process.env.FQDN}`
  : pulumi.interpolate`https://${distribution.domainName}`;
