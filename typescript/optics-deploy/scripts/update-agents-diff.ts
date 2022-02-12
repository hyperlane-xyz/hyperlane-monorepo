import { HelmCommand, runAgentHelmCommand } from '../src/agents';
import { getAgentConfig, getEnvironment, getChainConfigs } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const chains = await getChainConfigs(environment);
  for (const chain of chains) {
    await runAgentHelmCommand(
      HelmCommand.UpgradeDiff,
      agentConfig,
      chain,
      chains,
    );
  }
}

deploy().then(console.log).catch(console.error);
