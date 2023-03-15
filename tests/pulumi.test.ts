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
  public resources: { [key: string]: string } = {};
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
        hostedZoneId: 'mock',
        apiEndpoint: 'https://example.com',
      },
    };
    const resource = {
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
    console.log('Here');
    const statement = JSON.parse(assumeRolePolicy).Statement[0];

    expectTypeOf(test).toEqualTypeOf<aws.iam.Role>();
    expect(statement.Action).toMatch('sts:AssumeRole');
    expect(statement.Effect).toMatch('Allow');
    expect(statement.Principal.Service).toMatch('lambda.amazonaws.com');
  });

  it('buildServer', async () => {
    const iamForLambda = infra.getLambdaRole();
    const { httpApi, defaultRoute } = infra.buildServer(iamForLambda, 'mock', 128, {});

    const protocolType = await promiseOf(httpApi.protocolType);
    const apiId = await promiseOf(defaultRoute.apiId);
    const routeKey = await promiseOf(defaultRoute.routeKey);
    const target = await promiseOf(defaultRoute.target);

    console.log(mocks.resources);
    expectTypeOf(httpApi).toEqualTypeOf<aws.apigatewayv2.Api>();
    expectTypeOf(defaultRoute).toEqualTypeOf<aws.apigatewayv2.Route>();
    expect(protocolType).toMatch('HTTP');
    expect(apiId).toMatch('API-id');
    expect(routeKey).toMatch('$default');
    expect(target).toMatch('integrations/ServerIntegration-id');
  });
});
