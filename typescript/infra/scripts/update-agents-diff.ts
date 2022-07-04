import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function deploy() {
  const environment = await getEnvironment();

  const config = getCoreEnvironmentConfig(environment);
  await assertCorrectKubeContext(config);

  const agentConfig = await getContextAgentConfig();

  for (const chain of agentConfig.chainNames) {
    await runAgentHelmCommand<any>(HelmCommand.UpgradeDiff, agentConfig, chain);
  }
}

deploy().then(console.log).catch(console.error);
