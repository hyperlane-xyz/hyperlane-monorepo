import { runHelloworldKathyHelmCommand } from '../../src/helloworld/kathy';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironmentConfig,
} from '../utils';

import { getHelloWorldConfig } from './utils';

async function main() {
  const coreConfig = await getEnvironmentConfig();

  await assertCorrectKubeContext(coreConfig);

  const agentConfig = await getContextAgentConfig();
  const kathyConfig = getHelloWorldConfig(coreConfig).kathy;

  await runHelloworldKathyHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    kathyConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
