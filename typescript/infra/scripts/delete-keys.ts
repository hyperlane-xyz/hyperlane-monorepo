import { deleteAgentKeys } from '../src/agents/key-utils.js';

import { getAgentConfigsBasedOnArgs } from './agent-utils.js';

async function main() {
  const { agentConfig } = await getAgentConfigsBasedOnArgs();
  return deleteAgentKeys(agentConfig);
}

main().then(console.log).catch(console.error);
