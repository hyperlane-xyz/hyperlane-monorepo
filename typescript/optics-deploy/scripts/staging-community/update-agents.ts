import { HelmCommand, runAgentHelmCommand } from '../../src/agents';
import { agentConfig, configs } from './agentConfig';

async function deploy() {
  for (const config in configs) {
    await runAgentHelmCommand(
      HelmCommand.Upgrade,
      agentConfig,
      configs[config],
      configs,
    ),
      { depth: null };
  }
}

deploy().then(console.log).catch(console.error);
