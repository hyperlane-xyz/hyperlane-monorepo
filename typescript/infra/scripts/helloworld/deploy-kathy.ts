import { KathyHelmManager } from '../../src/helloworld/kathy.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

async function main() {
  const { envConfig, environment, context } = await getConfigsBasedOnArgs();
  await assertCorrectKubeContext(envConfig);

  const manager = KathyHelmManager.forEnvironment(environment, context);
  await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
