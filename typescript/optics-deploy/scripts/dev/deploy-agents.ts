import { HelmCommand, runAgentHelmCommand } from '../../src/agents';
import { chains } from '../../config/environments/dev/chains';
import { agentConfig } from '../../config/environments/dev/agent';

async function deploy() {
  for (const chain in chains) {
    await runAgentHelmCommand(
      HelmCommand.Install,
      agentConfig,
      chain,
      chains,
    ),
      { depth: null };
  }
}

deploy().then(console.log).catch(console.error);
