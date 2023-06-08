import { getAllCloudAgentKeys } from '../src/agents/key-utils';

import { getConfigsBasedOnArgs } from './utils';

async function main() {
  const { agentConfig } = await getConfigsBasedOnArgs();

  const keys = getAllCloudAgentKeys(agentConfig);
  const keyInfoPromises = keys.map(async (key) => {
    let address = '';
    try {
      await key.fetch();
      address = key.address;
    } catch (e) {
      // Swallow error
      console.error('Error getting address', { key: key.identifier });
    }
    return {
      identifier: key.identifier,
      address,
    };
  });
  const keyInfos = (await Promise.all(keyInfoPromises)).filter(
    // remove any keys we could not get an address for
    ({ address }) => !!address,
  );
  console.log(JSON.stringify(keyInfos, null, 2));
}

main().catch(console.error);
