import { deleteAgentKeys } from '../src/agents/key-utils';

import { getAgentConfigsBasedOnArgs } from './agent-utils';

async function main() {
  const { agentConfig } = await getAgentConfigsBasedOnArgs();
  return deleteAgentKeys(agentConfig);
}

main().then(console.log).catch(console.error);
