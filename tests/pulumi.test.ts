import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { hashElement } from 'folder-hash';

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { Mocks } from '@pulumi/pulumi/runtime';
import * as esbuild from 'esbuild';

import { adapter } from '../adapter';

vi.mock('esbuild', () => ({
  buildSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));


class MyMocks implements Mocks {
  public resources: { [key: string]: Record<string, any> } = {};
  newResource(args: pulumi.runtime.MockResourceArgs): {
    id: string | undefined;
    state: Record<string, any>;
  } {
    const id = `${args.name}-id`;
    const outputs = {
      id: id,
      state: {
        ...args.inputs,
        executionArn: `${args.name}-executionArn`,
        arn: `${args.name}-arn`,
        zoneId: `${args.name}-zone`,
        domainName: 'example.com',
        fqdn: 'server.example.com',
        hostedZoneId: `${args.name}-hostedZone`,
        apiEndpoint: 'https://example.com',
        domainValidationOptions: [
          {
            resourceRecordName: `${args.name}-resourceRecordName`,
            resourceRecordValue: `${args.name}-resourceRecordValue`,
          }
        ],
        bucketRegionalDomainName: 'bucket.s3.mock-west-1.amazonaws.com'
      },
    };
    const resource: Record<string, any> = {
      type: args.type,
      id,
      ...outputs.state,
    };
    this.resources[args.name] = resource;
    return outputs;
  }
  call(args: pulumi.runtime.MockCallArgs): Record<string, any> {
    return args.inputs;
  }
}

// Convert a pulumi.Output to a promise of the same type.
function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

function findResource(mocks: MyMocks, resourceType: string): Record<string, any> | undefined {
  for (const resource in mocks.resources) {
    if (mocks.resources[resource].type === resourceType) {
      return mocks.resources[resource]
    }
  }
  return undefined
}

describe('Pulumi IAC', () => {
  let envOrig: string;
  let infra: typeof import('../pulumi/resources');
  let mocks: MyMocks;

  beforeEach(async () => {
    vi.resetModules();
    envOrig = JSON.stringify(process.env);
    mocks = new MyMocks();
    pulumi.runtime.setMocks(mocks);
    infra = await import('../pulumi/resources');
  });

  afterEach(() => {
    process.env = JSON.parse(envOrig);
  });

  it('Store adapter props', async () => {
    const builder = {
      log: {
        minor: vi.fn((x) => console.log(x)),
      },
      writeClient: vi.fn(() => {
        return ['a', 'b', 'c'];
      }),
      writePrerendered: vi.fn(() => {
        return ['a', 'b', 'c'];
      }),
      writeServer: vi.fn(async (x) => {
        await fs.promises.appendFile(path.join(x, 'index.js'), '');
      }),
    };

    (esbuild.buildSync as any).mockImplementation(() => {
      return 'mock';
    });
    (spawnSync as any).mockImplementation(() => {
      return 'mock';
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), randomUUID()));

    const awsAdapter = adapter({
      artifactPath: tmpDir,
      iac: 'pulumi',
      autoDeploy: true,
    });
    await awsAdapter.adapt(builder);

    const propsPath = path.join(tmpDir, '.adapterprops.json');
    expect(fs.existsSync(propsPath)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('getLambdaRole', async () => {
    const test = infra.getLambdaRole();
    const assumeRolePolicy = await promiseOf(test.assumeRolePolicy);
    const statement = JSON.parse(assumeRolePolicy).Statement[0];

    expectTypeOf(test).toEqualTypeOf<aws.iam.Role>();
    expect(statement.Action).toMatch('sts:AssumeRole');
    expect(statement.Effect).toMatch('Allow');
    expect(statement.Principal.Service).toMatch('lambda.amazonaws.com');
  });

  it('buildServer', async () => {
    
    const memorySize = 128;
    const serverPath = 'mock'
    
    const iamForLambda = infra.getLambdaRole();
    const { httpApi, defaultRoute } = infra.buildServer(iamForLambda, serverPath, memorySize, {});
    
    const protocolType = await promiseOf(httpApi.protocolType);
    const expectedApiId = await promiseOf(httpApi.id);
    const executionArn = await promiseOf(httpApi.executionArn);
    
    expectTypeOf(httpApi).toEqualTypeOf<aws.apigatewayv2.Api>();
    expect(protocolType).toMatch('HTTP');
    
    const routeKey = await promiseOf(defaultRoute.routeKey);
    const routeApiId = await promiseOf(defaultRoute.apiId);
    
    expectTypeOf(defaultRoute).toEqualTypeOf<aws.apigatewayv2.Route>();
    expect(routeKey).toMatch('$default');
    expect(routeApiId).toMatch(expectedApiId);
    
    const target = await promiseOf(defaultRoute.target);
    const integrationMatch = target!.match("integrations/(.*?)-id")
    const serverIntegrationName = integrationMatch![1];
    
    expect(mocks.resources).toHaveProperty(serverIntegrationName)
    const serverIntegration = mocks.resources[serverIntegrationName]
    
    expect(serverIntegration.type).toMatch('aws:apigatewayv2/integration:Integration');
    expect(serverIntegration.apiId).toMatch(expectedApiId);
    expect(serverIntegration.integrationMethod).toMatch('POST');
    expect(serverIntegration.integrationType).toMatch('AWS_PROXY');
    expect(serverIntegration.payloadFormatVersion).toMatch('1.0');
    
    const lambdaMatch = serverIntegration.integrationUri.match("(.*?)-arn")
    const lambdaIntegrationName = lambdaMatch![1];
    
    expect(mocks.resources).toHaveProperty(lambdaIntegrationName)
    const lambda = mocks.resources[lambdaIntegrationName]
    const iamArn = await promiseOf(iamForLambda.arn);
    const codePath = await lambda.code.path;
    
    expect(lambda.type).toMatch('aws:lambda/function:Function');
    expect(lambda.handler).toMatch('index.handler');
    expect(lambda.memorySize).toEqual(memorySize);
    expect(lambda.runtime).toMatch('nodejs16.x');
    expect(lambda.timeout).toEqual(900);
    expect(lambda.role).toMatch(iamArn);
    expect(codePath).toMatch(serverPath);
    
    // Can't access role in mock outputs for RolePolicyAttachment
    const RPA = findResource(mocks, 'aws:iam/rolePolicyAttachment:RolePolicyAttachment')
    expect(RPA).toBeDefined();
    expect(RPA!.policyArn).toMatch('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
    
    const serverPermission = findResource(mocks, 'aws:lambda/permission:Permission')
    expect(serverPermission).toBeDefined();
    expect(serverPermission!.action).toMatch('lambda:InvokeFunction')
    expect(serverPermission!.principal).toMatch('apigateway.amazonaws.com')
    
    const sourceArnMatch = serverPermission!.sourceArn.match("(.*?)/\\*/\\*")
    const sourceArn = sourceArnMatch![1];
    expect(sourceArn).toMatch(executionArn);
    
    const functionId = await promiseOf(serverPermission!.function.id);
    expect(functionId).toMatch(lambda.id);
    
  });
  
  it('validateCertificate-Wrong-Domain', async () => {
    const FQDN = "server.example.com"
    const domainName = "another.com"
    expect(() => infra.validateCertificate(FQDN, domainName)).toThrowError("FQDN must contain domainName")
  });
  
  // Not sure how to capture the provider for the certificate or the pre-existing hosted zone
  it('validateCertificate', async () => {
    
    const FQDN = "server.example.com"
    const domainName = "example.com"
    
    const certificateArn = await promiseOf(infra.validateCertificate(FQDN, domainName))
    const certificateValidation = findResource(mocks, 'aws:acm/certificateValidation:CertificateValidation')
    
    expect(certificateValidation!.certificateArn).toMatch(certificateArn)
    expect(certificateValidation!.validationRecordFqdns[0]).toMatch("server.example.com")
    
    const validationRecord = findResource(mocks, 'aws:route53/record:Record')
    const certificateMatch = validationRecord!.name.match("(.*?)-resourceRecordName")
    const certificateName = certificateMatch![1];
    
    expect(mocks.resources).toHaveProperty(certificateName)
    const certificate = mocks.resources[certificateName]
    
    // The type input to aws:route53/record:Record isn't handled
    expect(certificate.type).toMatch('aws:acm/certificate:Certificate');
    expect(certificate.domainName).toMatch(domainName)
    expect(certificate.validationMethod).toMatch('DNS')
    
    expect(validationRecord!.name).toMatch(certificate.domainValidationOptions[0].resourceRecordName)
    expect(validationRecord!.records[0]).toMatch(certificate.domainValidationOptions[0].resourceRecordValue)
    expect(validationRecord!.ttl).toEqual(60)
    
  });
  
  it('uploadStatic', async () => {
    
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), randomUUID()));
    const childDir = path.join(tmpDir, 'child');
    
    fs.mkdirSync(childDir);
    fs.closeSync(fs.openSync(path.join(tmpDir, 'a.mock'), 'w'));
    fs.closeSync(fs.openSync(path.join(childDir, 'b.mock'), 'w'));
    
    const bucket = new aws.s3.Bucket('MockBucket');
    const bucketId = await promiseOf(bucket.id)
    infra.uploadStatic(tmpDir, bucket)
    
    fs.rmSync(tmpDir, { recursive: true });
    
    // Need to wait for the mocks to update
    await new Promise(r => setTimeout(r, 100));
    var fileArray = ['a.mock', path.join('child', 'b.mock')]
    
    for (let fileName of fileArray) {
      const posixFilePath = fileName.split(path.sep).join(path.posix.sep)
      expect(mocks.resources).toHaveProperty(posixFilePath)
      
      const item = mocks.resources[posixFilePath]
      expect(item.type).toMatch('aws:s3/bucketObject:BucketObject')
      expect(item.key).toMatch(posixFilePath)
      expect(item.bucket).toMatch(bucketId)
      
      const sourcePath = await item.source.path
      expect(sourcePath).toContain(fileName)
    }
    
  });
  
  it('buildStatic', async () => {
    const spy = vi.spyOn(infra, "uploadStatic").mockImplementation(() => null);
    infra.buildStatic('mock', 'mock')
    expect(spy).toHaveBeenCalledTimes(2)
    
    // Need to wait for the mocks to update
    await new Promise(r => setTimeout(r, 100));
    
    expect(Object.keys(mocks.resources)).toHaveLength(1)
    const resource = Object.values(mocks.resources)[0]
    
    expect(resource.type).toMatch('aws:s3/bucket:Bucket')
    expect(resource.acl).toMatch('private')
    expect(resource.forceDestroy).toBe(true)
    
  });
  
  it('buildCDN', async () => {
    
    const httpApi = new aws.apigatewayv2.Api('MockAPI', {
      protocolType: 'HTTP',
    });
    const bucket = new aws.s3.Bucket('MockBucket');
    const certificateArn = 'MockCertificateArn'
    const routes = ["mock/*"]
    
    const distribution = infra.buildCDN(
      httpApi,
      bucket,
      certificateArn,
      routes)
    
    const distOrigins = await promiseOf(distribution.origins)
    console.log(distOrigins)
    
    expect(distOrigins).toHaveLength(2)
    
    let customOriginIndex: number | undefined
    
    for (const [i, value] of distOrigins.entries()) {
      if (value.hasOwnProperty('customOriginConfig')) {
        customOriginIndex = i
        break
      }
    }
    
    expect(customOriginIndex).toBeDefined()
    const customOrigin = distOrigins[customOriginIndex!]
    expect(customOrigin.domainName).toMatch('example.com')
    expect(customOrigin.customOriginConfig!.httpPort).toBe(80)
    expect(customOrigin.customOriginConfig!.httpsPort).toBe(443)
    expect(customOrigin.customOriginConfig!.originProtocolPolicy).toMatch('https-only')
    expect(customOrigin.customOriginConfig!.originSslProtocols).toEqual([
      'SSLv3', 'TLSv1', 'TLSv1.1', 'TLSv1.2'
    ])
    
    let s3OriginIndex: number | undefined
    
    for (const [i, value] of distOrigins.entries()) {
      if (value.hasOwnProperty('originAccessControlId')) {
        s3OriginIndex = i
        break
      }
    }
    
    expect(s3OriginIndex).toBeDefined()
    const s3Origin = distOrigins[s3OriginIndex!]
    expect(s3Origin.domainName).toMatch('bucket.s3.mock-west-1.amazonaws.com')
    
    const oacMatch = s3Origin.originAccessControlId!.match("(.*?)-id")
    const oacName = oacMatch![1];
    const oac = mocks.resources[oacName];
    
    console.log(oac)
    expect(oac.type).toMatch('aws:cloudfront/originAccessControl:OriginAccessControl')
    
  });
  
  
});
