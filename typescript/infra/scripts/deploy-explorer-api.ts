import {
  applyHasuraMetadataViaPortForward,
  getHasuraExplorerConfig,
  runHasuraExplorerHelmCommand,
} from '../src/infrastructure/explorer-api/index.js';
import { HelmCommand } from '../src/utils/helm.js';

import { assertCorrectKubeContext, getArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const argv = await getArgs()
    .describe('apply-metadata', 'Apply Hasura metadata after deploy')
    .boolean('apply-metadata')
    .default('apply-metadata', false).argv;

  const envConfig = getEnvironmentConfig(argv.environment);
  await assertCorrectKubeContext(envConfig);

  const hasuraConfig = getHasuraExplorerConfig(argv.environment);

  await runHasuraExplorerHelmCommand(
    HelmCommand.InstallOrUpgrade,
    hasuraConfig,
  );

  if (argv['apply-metadata']) {
    await applyHasuraMetadataViaPortForward(hasuraConfig);
  }
}

main().then(console.log).catch(console.error);
