import { HelmCommand, runAgentHelmCommand } from '../../src/agents';
import { chains } from '../../config/environments/testnet/chains';
import { agentConfig } from '../../config/environments/testnet/agent';

async function deploy() {
  for (const chain of chains) {
    await runAgentHelmCommand(
      HelmCommand.UpgradeDiff,
      agentConfig,
      chain,
      chains,
    );
  }
}

deploy().then(console.log).catch(console.error);
