import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  for (const chain of config.agent.chainNames) {
    await runAgentHelmCommand<any>(
      HelmCommand.UpgradeDiff,
      config.agent,
      chain,
    );
  }
}

deploy().then(console.log).catch(console.error);
