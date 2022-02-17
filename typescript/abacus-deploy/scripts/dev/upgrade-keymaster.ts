import { HelmCommand, runKeymasterHelmCommand } from '../../src/agents';
import { agentConfig } from '../../config/environments/dev/agent';
import { chains } from '../../config/environments/dev/chains';

async function main() {
  return runKeymasterHelmCommand(HelmCommand.Upgrade, agentConfig, chains);
}

main().then(console.log).catch(console.error);
