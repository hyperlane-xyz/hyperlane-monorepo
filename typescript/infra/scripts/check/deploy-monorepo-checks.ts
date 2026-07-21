import { Contexts } from '../../config/contexts.js';
import { MonorepoChecksHelmManager } from '../../src/monorepo-checks/helm.js';
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

  const manager = MonorepoChecksHelmManager.forEnvironment(environment);
  if (!manager) {
    throw new Error('No monorepoChecksConfig found');
  }

  await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
