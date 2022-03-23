import { runKeymasterHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getAgentConfig, getChainConfigs, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const agentConfig = await getAgentConfig(environment);
  return runKeymasterHelmCommand(HelmCommand.Install, agentConfig, chains);
}

main().then(console.log).catch(console.error);
