import { deleteAgentKeys } from '../src/agents/key-utils';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);

  return deleteAgentKeys(config.agent);
}

main().then(console.log).catch(console.error);
