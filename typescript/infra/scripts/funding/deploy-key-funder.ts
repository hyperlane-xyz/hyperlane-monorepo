import chalk from 'chalk';

import { Contexts } from '../../config/contexts.js';
import { KeyFunderHelmManager } from '../../src/funding/key-funder.js';
import { checkMonorepoImageExists } from '../../src/utils/gcloud.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

async function main() {
  const { agentConfig, envConfig, environment } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  if (envConfig.keyFunderConfig?.docker.tag) {
    const exists = await checkMonorepoImageExists(
      envConfig.keyFunderConfig.docker.tag,
    );
    if (!exists) {
      console.log(
        chalk.red(
          `Attempted to deploy key funder with image tag ${chalk.bold(
            envConfig.keyFunderConfig.docker.tag,
          )}, but it has not been published to GCR.`,
        ),
      );
      process.exit(1);
    }
  }

  const manager = KeyFunderHelmManager.forEnvironment(environment);
  await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
