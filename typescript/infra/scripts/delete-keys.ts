import { deleteAgentKeys } from '../src/agents/key-utils';

import { getContextAgentConfig } from './utils';

async function main() {
  const agentConfig = await getContextAgentConfig();
  return deleteAgentKeys(agentConfig);
}

main().then(console.log).catch(console.error);
