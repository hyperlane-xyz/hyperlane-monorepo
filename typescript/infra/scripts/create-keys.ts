import { createAgentKeysIfNotExists } from '../src/agents/key-utils.js';

import { getAgentConfigsBasedOnArgs } from './agent-utils.js';

async function main() {
  const { agentConfig } = await getAgentConfigsBasedOnArgs();
  await createAgentKeysIfNotExists(agentConfig);
  return 'Keys created successfully!';
}

main().then(console.log).catch(console.error);
