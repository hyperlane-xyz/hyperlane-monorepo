import { createAgentKeysIfNotExists } from '../src/agents/key-utils';

import { getAgentConfigsBasedOnArgs } from './utils';

async function main() {
  const { agentConfig, newThresholds } = await getAgentConfigsBasedOnArgs();
  console.log('agentConfig', JSON.stringify(agentConfig, null, 2));
  return createAgentKeysIfNotExists(agentConfig, newThresholds);
}

main().then(console.log).catch(console.error);
