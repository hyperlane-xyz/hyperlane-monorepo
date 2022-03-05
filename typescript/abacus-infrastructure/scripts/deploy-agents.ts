import { getAgentConfig, getEnvironment, getChainConfigs } from './utils';
import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

async function deploy() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const agentConfig = await getAgentConfig(environment);
  const domains = Object.keys(chains).map((d) => parseInt(d));
  const chainArray = domains.map((d) => chains[d]);
  await Promise.all(
    chainArray.map((chain) => {
      return runAgentHelmCommand(
        HelmCommand.Upgrade,
        agentConfig,
        chain,
        chainArray,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
