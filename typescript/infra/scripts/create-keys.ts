import { createAgentKeysIfNotExists } from '../src/agents/key-utils';

import { getAgentConfigsBasedOnArgs } from './agent-utils';

async function main() {
  const { agentConfig, newThresholds } = await getAgentConfigsBasedOnArgs();
  return createAgentKeysIfNotExists(agentConfig, newThresholds);
}

main().then(console.log).catch(console.error);
