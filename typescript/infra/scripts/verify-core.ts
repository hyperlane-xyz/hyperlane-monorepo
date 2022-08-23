import { existsSync, readFileSync } from 'fs';
import path from 'path';

import {
  CompilerOptions,
  CompleteChainMap,
  ContractVerifier,
} from '@abacus-network/sdk';

import { fetchGCPSecret } from '../src/utils/gcloud';
import { execCmd, readJSON } from '../src/utils/utils';

import {
  getCoreEnvironmentConfig,
  getCoreVerificationDirectory,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment) as any;
  const multiProvider = await config.getMultiProvider();

  const verification = readJSON(
    getCoreVerificationDirectory(environment),
    'verification.json',
  );

  const sourcePath = path.join(
    getCoreVerificationDirectory(environment),
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

  return verifier.verify();
}

main().then(console.log).catch(console.error);
