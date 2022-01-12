import { HelmCommand, runKeymasterHelmCommand } from '../../src/agents';
import { agentConfig, configs } from './agentConfig';

async function main() {
  return runKeymasterHelmCommand(HelmCommand.Upgrade, agentConfig, configs);
}

main().then(console.log).catch(console.error);
