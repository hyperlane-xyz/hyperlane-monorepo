import { deleteAgentKeys } from '../src/agents/key-utils';

import { getConfigsBasedOnArgs } from './utils';

async function main() {
  const { agentConfig } = await getConfigsBasedOnArgs();
  return deleteAgentKeys(agentConfig);
}

main().then(console.log).catch(console.error);
