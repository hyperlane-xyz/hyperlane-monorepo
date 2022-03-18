import { getAgentConfig, getEnvironment, getChainConfigs } from './utils';
import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

async function deploy() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const agentConfig = await getAgentConfig(environment);
  await Promise.all(
    chains.map((chain) => {
      return runAgentHelmCommand(
        HelmCommand.Upgrade,
        agentConfig,
        chain,
        chains,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
