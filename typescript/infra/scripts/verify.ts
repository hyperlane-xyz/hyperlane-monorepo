import {
  ChainMap,
  ExplorerLicenseType,
  PostDeploymentContractVerifier,
  VerificationInput,
} from '@hyperlane-xyz/sdk';

import { extractSource, fetchExplorerApiKeys } from '../src/deployment/verify';
import { readJSONAtPath } from '../src/utils/utils';

import {
  assertEnvironment,
  getArgs,
  withBuildArtifact,
  withNetwork,
} from './agent-utils';
import { getEnvironmentConfig } from './core-utils';

async function main() {
  const { environment, buildArtifact, verificationArtifact, network } =
    await withNetwork(withBuildArtifact(getArgs()))
      .string('verificationArtifact')
      .describe(
        'verificationArtifact',
        'path to hyperlane verification artifact',
      )
      .alias('v', 'verificationArtifact')
      .demandOption('verificationArtifact')
      .demandOption('buildArtifact').argv;

  // set up multiprovider
  assertEnvironment(environment);
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // grab verification artifacts
  const verification: ChainMap<VerificationInput> =
    readJSONAtPath(verificationArtifact);

  // extract source from build artifact
  const { source, compilerversion } = extractSource(buildArtifact);

  // fetch explorer API keys from GCP
  const apiKeys = await fetchExplorerApiKeys();

  // instantiate verifier
  const verifier = new PostDeploymentContractVerifier(
    verification,
    multiProvider,
    apiKeys,
    source,
    {
      compilerversion,
      licenseType: ExplorerLicenseType.MIT,
    },
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
