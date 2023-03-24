
import * as pulumi from '@pulumi/pulumi';

import { MyMocks, promiseOf } from './utils'
import * as resources from '../pulumi/resources';

vi.mock('../pulumi/resources')

describe('pulumi/index.ts', () => {
  
  let envOrig: string;
  let mocks: MyMocks;
  let infra: typeof import('../pulumi');
  
  beforeEach(async () => {
    vi.resetModules();
    envOrig = JSON.stringify(process.env);
    mocks = new MyMocks();
    pulumi.runtime.setMocks(mocks);
  });
  
  afterEach(() => {
    process.env = JSON.parse(envOrig);
  });
  
  it('Without FQDN', async () => {
    
    (resources.buildServer as any).mockImplementation(() => {
      return {
        httpApi: 'mock',
        defaultRoute: 'mock'
      };
    });
    
    (resources.buildCDN as any).mockImplementation(() => {
      return {
        domainName: 'example.com',
      };
    });
    
    let checkOrigins: (pulumi.Output<string>)[]
    
    (resources.buildServerOptionsHandler as any).mockImplementation(async (iamForLambda: any, httpApi: any, allowedOrigins: any) => {
      checkOrigins = allowedOrigins
    });
    
    infra = await import('../pulumi');
    
    expect(resources.getEnvironment).toHaveBeenCalledTimes(1)
    expect(resources.getLambdaRole).toHaveBeenCalledTimes(1)
    expect(resources.buildServer).toHaveBeenCalledTimes(1)
    expect(resources.validateCertificate).toHaveBeenCalledTimes(0)
    expect(resources.buildStatic).toHaveBeenCalledTimes(1)
    expect(resources.buildCDN).toHaveBeenCalledTimes(1)
    expect(resources.createAliasRecord).toHaveBeenCalledTimes(0)
    expect(resources.buildServerOptionsHandler).toHaveBeenCalledTimes(1)
    expect(resources.deployServer).toHaveBeenCalledTimes(1)
    expect(resources.buildInvalidator).toHaveBeenCalledTimes(1)
    
    expect(checkOrigins!).toBeDefined()
    expect(checkOrigins!).toHaveLength(1)
    const allowedOrigins = await promiseOf(checkOrigins![0]);
    expect(allowedOrigins).toMatch('https://example.com')
    
    console.log(infra.appUrl)
    
    
    
  })
  
})