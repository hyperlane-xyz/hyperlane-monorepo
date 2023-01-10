import {
  CompilerOptions,
  CompleteChainMap,
  ContractVerifier,
} from '@hyperlane-xyz/sdk';

import { fetchGCPSecret } from '../src/utils/gcloud';
import { execCmd, readFileAtPath, readJSONAtPath } from '../src/utils/utils';

import { assertEnvironment, getArgs, getCoreEnvironmentConfig } from './utils';

async function main() {
  const argv = await getArgs()
    .string('source')
    .describe('source', 'flattened solidity source file')
    .demandOption('source')
    .string('artifacts')
    .describe('artifacts', 'verification artifacts JSON file')
    .demandOption('artifacts')
    .string('network')
    .describe('network', 'optional target network').argv;

  const environment = assertEnvironment(argv.e!);
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const verification = readJSONAtPath(argv.artifacts!);

  const sourcePath = argv.source!;
  const flattenedSource = readFileAtPath(sourcePath);

  // from solidity/core/hardhat.config.ts
  const compilerOptions: CompilerOptions = {
    codeformat: 'solidity-single-file',
    compilerversion: 'v0.8.17+commit.8df45f5f',
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

  return verifier.verify(argv.network ? [argv.network] : undefined);
}

main().then(console.log).catch(console.error);
