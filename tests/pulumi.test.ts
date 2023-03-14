
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process'
import { hashElement } from 'folder-hash';

import * as pulumi from "@pulumi/pulumi"
import * as esbuild from 'esbuild'

import { adapter } from "../adapter"

vi.mock('esbuild', () => ({
    buildSync: vi.fn()
}));

vi.mock('child_process', () => ({
    spawnSync: vi.fn()
    
}));


// Convert a pulumi.Output to a promise of the same type.
function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
    return new Promise(resolve => output.apply(resolve));
}

describe("Pulumi IAC", () => {
    
    let envOrig: string;
    let infra: typeof import("../pulumi/index");
    
    beforeEach(() => {
        envOrig = JSON.stringify(process.env);
    })
    
    beforeAll(() => {
        
        // Put Pulumi in unit-test mode, mocking all calls to cloud-provider APIs.
        pulumi.runtime.setMocks({

            // Mock requests to provision cloud resources and return a canned response.
            newResource: (args: pulumi.runtime.MockResourceArgs): any => {

                // Here, we're returning a same-shaped object for all resource types.
                // We could, however, use the arguments passed into this function to
                // customize the mocked-out properties of a particular resource based
                // on its type. See the unit-testing docs for details:
                // https://www.pulumi.com/docs/guides/testing/unit
                return {
                    id: `${args.name}-id`,
                    state: {
                        ...args.inputs,
                        executionArn: `${args.name}-executionArn`,
                        arn: `${args.name}-arn`,
                        zoneId: `${args.name}-zone`,
                        domainName: 'example.com',
                        hostedZoneId: 'mock',
                        apiEndpoint: 'https://example.com'
                    }
                };
            },

            // Mock function calls and return whatever input properties were provided.
            call: (args: pulumi.runtime.MockCallArgs) => {
                return args.inputs;
            },
        });
    });
    
    afterEach(() => {
        process.env = JSON.parse(envOrig);
    });
    
    it('Store adapter props', async () => {
        
        const builder = {
            log: {
                minor: vi.fn((x) => console.log(x))
            },
            writeClient: vi.fn(() => {
                return ['a', 'b', 'c']
            }),
            writePrerendered: vi.fn(() => {
                return ['a', 'b', 'c']
            }),
            writeServer: vi.fn(async (x) => {
                await fs.promises.appendFile(path.join(x, 'index.js'), '')
            }),
        };
        
        (esbuild.buildSync as any).mockImplementation(() => {
            return "mock"
        });
        (spawnSync as any).mockImplementation(() => {
            return "mock"
        });
        
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), randomUUID()));
        
        const awsAdapter = adapter({
            artifactPath: tmpDir,
            iac: 'pulumi',
            autoDeploy: true
        });
        await awsAdapter.adapt(builder)
        
        const propsPath = path.join(tmpDir, '.adapterprops.json');
        expect(fs.existsSync(propsPath)).toBe(true);
        
        fs.rmSync(tmpDir, { recursive: true })
    });
    
    it('Infrastructure', async () => {
        
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), randomUUID()));
        fs.mkdirSync(path.join(tmpDir, 'server'));
        
        const serverPath = path.join(tmpDir, 'server', 'index.js')
        await fs.promises.appendFile(serverPath, '')
        
        process.env.SERVER_PATH = serverPath
        process.env.STATIC_PATH = tmpDir
        process.env.PRERENDERED_PATH = tmpDir
        
        infra = await import('../pulumi/index');
    },
    10000)
    
});
