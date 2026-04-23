import { Contexts } from '../../config/contexts.js';
import { CheckWarpDeployHelmManager } from '../../src/check-warp-deploy/helm.js';
import { verifyImagesAndConfirm } from '../../src/utils/attestation.js';
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

  const manager = CheckWarpDeployHelmManager.forEnvironment(environment);
  if (!manager) {
    throw new Error('No checkWarpDeployConfig found');
  }

  await verifyImagesAndConfirm([
    {
      component: 'check-warp-deploy',
      image: manager.config.docker.repo,
      tag: manager.config.docker.tag,
    },
  ]);

  await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
