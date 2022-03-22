import { runKeymasterHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getAgentConfig, getDomainNames, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const domainNames = await getDomainNames(environment);
  const agentConfig = await getAgentConfig(environment);
  return runKeymasterHelmCommand(HelmCommand.Upgrade, agentConfig, domainNames);
}

main().then(console.log).catch(console.error);
