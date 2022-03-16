import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getAgentConfig, getEnvironment, getChainConfigs } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const chains = await getChainConfigs(environment);
  for (const chain of chains) {
    await runAgentHelmCommand(HelmCommand.Upgrade, agentConfig, chain, chains);
  }
}

deploy().then(console.log).catch(console.error);
