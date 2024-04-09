import {
  ChainMap,
  ExplorerLicenseType,
  PostDeploymentContractVerifier,
  VerificationInput,
} from '@hyperlane-xyz/sdk';

import {
  extractBuildArtifact,
  fetchExplorerApiKeys,
} from '../src/deployment/verify.js';
import { readJSONAtPath } from '../src/utils/utils.js';

import {
  assertEnvironment,
  getArgs,
  withBuildArtifactPath,
  withNetwork,
} from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const { environment, buildArtifactPath, verificationArtifactPath, network } =
    await withNetwork(withBuildArtifactPath(getArgs()))
      .string('verificationArtifactPath')
      .describe(
        'verificationArtifactPath',
        'path to hyperlane verification artifact',
      )
      .alias('v', 'verificationArtifactPath')
      .demandOption('verificationArtifactPath')
      .demandOption('buildArtifactPath').argv;

  // set up multiprovider
  assertEnvironment(environment);
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // grab verification artifacts
  const verification: ChainMap<VerificationInput> = readJSONAtPath(
    verificationArtifactPath,
  );

  // fetch explorer API keys from GCP
  const apiKeys = await fetchExplorerApiKeys();

  // extract build artifact contents
  const buildArtifact = extractBuildArtifact(buildArtifactPath);

  // instantiate verifier
  const verifier = new PostDeploymentContractVerifier(
    verification,
    multiProvider,
    apiKeys,
    buildArtifact,
    ExplorerLicenseType.MIT,
  );

  // verify all the things
  const failedResults = (
    await verifier.verify(network ? [network] : undefined)
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
