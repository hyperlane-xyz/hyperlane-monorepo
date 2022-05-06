import { createAgentKeysIfNotExists } from '../src/agents/key-utils';

import { getEnvironmentConfig } from './utils';

async function main() {
  const config = await getEnvironmentConfig();
  return createAgentKeysIfNotExists(config.agent);
}

main().then(console.log).catch(console.error);
