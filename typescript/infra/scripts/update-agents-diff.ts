import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironment,
  getEnvironmentConfig,
} from './utils';

async function deploy() {
  const environment = await getEnvironment();

  const config = getEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);

  const agentConfig = await getContextAgentConfig(config);

  for (const chain of agentConfig.contextChainNames) {
    await runAgentHelmCommand(HelmCommand.UpgradeDiff, agentConfig, chain);
  }
}

deploy().then(console.log).catch(console.error);
