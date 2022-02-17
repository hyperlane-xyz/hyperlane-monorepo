import { HelmCommand, runKeymasterHelmCommand } from '../../src/agents';
import { chains } from '../../config/environments/dev/chains';
import { agentConfig } from '../../config/environments/dev/agent';

async function main() {
  return runKeymasterHelmCommand(HelmCommand.Install, agentConfig, chains);
}

main().then(console.log).catch(console.error);
