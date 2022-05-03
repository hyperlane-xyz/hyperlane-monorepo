import { deleteAgentKeys } from '../src/agents/gcp';

import { getAgentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);

  return deleteAgentKeys(agentConfig);
}

main().then(console.log).catch(console.error);
