import { getAgentConfig, getEnvironment, getChainConfigs } from './utils';
import { HelmCommand, runAgentHelmCommand } from '../src/agents';

async function deploy() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const agentConfig = await getAgentConfig(environment);
  await Promise.all(
    chains.map((chain) => {
      return runAgentHelmCommand(
        HelmCommand.Install,
        agentConfig,
        chain,
        chains,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
