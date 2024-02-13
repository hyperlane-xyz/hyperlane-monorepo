import {
  ChainMap,
  PostDeploymentContractVerifier,
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

  // set up multiprovider
  const environment = assertEnvironment(argv.e!);
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // grab verification artifacts
  const verification: ChainMap<VerificationInput> = readJSONAtPath(
    argv.artifacts!,
  );

  // check provided artifact is JSON
  const sourcePath = argv.source!;
  if (!sourcePath.endsWith('.json')) {
    throw new Error('Source must be a JSON file.');
  }

  // parse build artifacts for std input json + solc version
  const buildArtifactJson = readJSONAtPath(sourcePath);
  const source = buildArtifactJson.input;
  const solcLongVersion = buildArtifactJson.solcLongVersion;
  const compilerversion = `v${solcLongVersion}`;

  // check solc version is in the right format
  const versionRegex = /v(\d.\d.\d+)\+commit.\w+/;
  const matches = versionRegex.exec(compilerversion);
  if (!matches) {
    throw new Error(`Invalid compiler version ${compilerversion}`);
  }

  // fetch API keys from GCP
  const apiKeys: ChainMap<string> = (await fetchGCPSecret(
    'explorer-api-keys',
    true,
  )) as any;

  // instantiate verifier
  const verifier = new PostDeploymentContractVerifier(
    verification,
    multiProvider,
    apiKeys,
    source,
    {
      compilerversion,
      // MIT license by default
    },
  );

  // verify all the things
  const failedResults = (
    await verifier.verify(argv.network ? [argv.network] : undefined)
  ).filter((result) => result.status === 'rejected');

  // only log the failed verifications to console
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
