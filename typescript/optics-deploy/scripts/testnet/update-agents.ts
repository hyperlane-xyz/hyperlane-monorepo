import { HelmCommand, runAgentHelmCommand } from '../../src/agents';
import { chains } from '../../config/environments/testnet/chains';
import { agentConfig } from '../../config/environments/testnet/agent';
import { ChainConfig } from '../../src/config/chain';

async function deploy() {
  await Promise.all(
    chains.map((chain: ChainConfig) => {
      return runAgentHelmCommand(
        HelmCommand.Upgrade,
        agentConfig,
        chain,
        chains,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
