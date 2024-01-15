import { getAgentConfigsBasedOnArgs } from './utils';

async function main() {
  console.log('before');
  const { agentConfig } = await getAgentConfigsBasedOnArgs();
  console.log('agentConfig', agentConfig);
  // return createAgentKeysIfNotExists(agentConfig);
}

main().then(console.log).catch(console.error);
