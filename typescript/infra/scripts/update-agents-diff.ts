import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getAgentConfig, getDomainNames, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);
  for (const name of domainNames) {
    await runAgentHelmCommand(
      HelmCommand.UpgradeDiff,
      agentConfig,
      name,
      domainNames,
    );
  }
}

deploy().then(console.log).catch(console.error);
