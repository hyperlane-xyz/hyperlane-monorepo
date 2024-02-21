import {
  ChainMap,
  CompilerOptions,
  ContractVerifier,
  VerificationInput,
} from '@hyperlane-xyz/sdk';

import { fetchGCPSecret } from '../src/utils/gcloud';
import { readJSONAtPath } from '../src/utils/utils';

import { assertEnvironment, getArgs } from './agent-utils';
import { getEnvironmentConfig } from './core-utils';

async function main() {
  const argv = await getArgs()
    .string('source')
    .describe(
      'source',
      'Path to hardhat build artifact containing standard input JSON',
    )
    .demandOption('source')
    .string('artifacts')
    .describe('artifacts', 'verification artifacts JSON file')
    .demandOption('artifacts')
    .string('network')
    .describe('network', 'optional target network').argv;

  const environment = assertEnvironment(argv.e!);
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const verification: ChainMap<VerificationInput> = readJSONAtPath(
    argv.artifacts!,
  );

  const sourcePath = argv.source!;
  if (!sourcePath.endsWith('.json')) {
    throw new Error('Source must be a JSON file.');
  }

  const buildArtifactJson = readJSONAtPath(sourcePath);
  const source = buildArtifactJson.input;
  const solcLongVersion = buildArtifactJson.solcLongVersion;

  // codeformat always json
  // compiler version inferred from build artifact
  // always use MIT license
  const compilerOptions: CompilerOptions = {
    codeformat: 'solidity-standard-json-input',
    compilerversion: `v${solcLongVersion}`,
    licenseType: '3',
  };

  const versionRegex = /v(\d.\d.\d+)\+commit.\w+/;
  const matches = versionRegex.exec(compilerOptions.compilerversion);
  if (!matches) {
    throw new Error(
      `Invalid compiler version ${compilerOptions.compilerversion}`,
    );
  }

  const apiKeys: ChainMap<string> = (await fetchGCPSecret(
    'explorer-api-keys',
    true,
  )) as any;

  const verifier = new ContractVerifier(
    verification,
    multiProvider,
    apiKeys,
    source,
    compilerOptions,
  );

  const failedResults = (
    await verifier.verify(argv.network ? [argv.network] : undefined)
  ).filter((result) => result.status === 'rejected');

  if (failedResults.length > 0) {
    console.error(
      'Verification failed for the following contracts:',
      failedResults.map((result) => result),
    );
    process.exit(1);
  }

  process.exit(0);
}

main().then(console.log).catch(console.error);
