import { deleteAgentKeys } from '../src/agents/key-utils';
import { getEnvironmentConfig } from './utils';


async function main() {
  const config = await getEnvironmentConfig();
  return deleteAgentKeys(config.agent);
}

main().then(console.log).catch(console.error);
