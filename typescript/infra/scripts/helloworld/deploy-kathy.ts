import { runHelloworldKathyHelmCommand } from '../../src/helloworld/kathy.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

import { getHelloWorldConfig } from './utils.js';

async function main() {
  const { agentConfig, envConfig, context } = await getConfigsBasedOnArgs();
  await assertCorrectKubeContext(envConfig);
  const kathyConfig = getHelloWorldConfig(envConfig, context).kathy;

  await runHelloworldKathyHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    kathyConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
