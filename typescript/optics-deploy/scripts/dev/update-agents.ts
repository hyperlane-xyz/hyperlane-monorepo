import { HelmCommand, runAgentHelmCommand } from '../../src/agents';
import { chains } from '../../config/environments/dev/chains';
import { agentConfig } from '../../config/environments/dev/agent';

async function deploy() {
  for (const chain of chains) {
    await runAgentHelmCommand(HelmCommand.Upgrade, agentConfig, chain, chains);
  }
}

deploy().then(console.log).catch(console.error);
