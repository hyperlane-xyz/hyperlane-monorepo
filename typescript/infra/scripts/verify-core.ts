import { existsSync, readFileSync } from 'fs';
import path, { join } from 'path';

import { CompleteChainMap, ContractVerifier } from '@abacus-network/sdk';
import { CompilerOptions } from '@abacus-network/sdk/dist/deploy/verify/types';

import { fetchGCPSecret } from '../src/utils/gcloud';
import { execCmd, readJSON } from '../src/utils/utils';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider = await config.getMultiProvider();

  const verification = readJSON(
    join(getEnvironmentDirectory(environment), 'testrecipient'),
    'verification.json',
  );

  const sourcePath = path.join(
    join(getEnvironmentDirectory(environment), 'testrecipient'),
    'flattened.sol',
  );
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Could not find flattened source at ${sourcePath}, run 'yarn hardhat flatten' in 'solidity/core'`,
    );
  }

  // from solidity/core/hardhat.config.ts
  const compilerOptions: CompilerOptions = {
    codeformat: 'solidity-single-file',
    compilerversion: 'v0.8.13+commit.abaa5c0e',
    optimizationUsed: '1',
    runs: '999999',
  };

  const versionRegex = /v(\d.\d.\d+)\+commit.\w+/;
  const matches = versionRegex.exec(compilerOptions.compilerversion);
  if (!matches) {
    throw new Error(
      `Invalid compiler version ${compilerOptions.compilerversion}`,
    );
  }

  // ensures flattened source is compilable
  await execCmd(`solc-select use ${matches[1]}`);
  await execCmd(`solc ${sourcePath}`);

  const flattenedSource = readFileSync(sourcePath, { encoding: 'utf8' });
  const apiKeys: CompleteChainMap<string> = await fetchGCPSecret(
    'explorer-api-keys',
    true,
  );

  const verifier = new ContractVerifier(
    verification,
    multiProvider,
    apiKeys,
    flattenedSource,
    compilerOptions,
  );
  console.log(verifier);

  return verifier.verify();
}

main().then(console.log).catch(console.error);
