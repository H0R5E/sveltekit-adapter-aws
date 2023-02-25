#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { join } from 'path';
import { config } from 'dotenv';

const env = config({ path: join(process.cwd(), '.env') }).parsed;
const artifactPath = 'build';
const static_directory = join(artifactPath, 'assets');
const prerendered_directory = join(artifactPath, 'prerendered');
const server_directory = join(artifactPath, 'server');

if (env && ("iac" in env)) {
  if (env.iac == "cdk") {
    spawnSync('npx', ['cdk',
                      'destroy',
                      '--app',
                      `${__dirname}/../deploy/index.js`,
                      '*',
                      '--force'], {
      cwd: __dirname,
      stdio: [process.stdin, process.stdout, process.stderr],
      env: Object.assign(
        {
          SERVER_PATH: join(process.cwd(), server_directory),
          STATIC_PATH: join(process.cwd(), static_directory),
          PRERENDERED_PATH: join(process.cwd(), prerendered_directory),
          ...env,
        },
        process.env
      ),
    });
  } else if (env.iac == "pulumi") {
    spawnSync('pulumi', ['destroy', '-f', '-s', env.stackName, '-y'], {
      cwd: env.pulumiProjectPath,
      stdio: [process.stdin, process.stdout, process.stderr],
      env: process.env
    });
  }
}
