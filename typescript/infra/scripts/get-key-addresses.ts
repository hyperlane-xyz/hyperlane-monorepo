import { getAllKeys } from '../src/agents/key-utils';

import { getContextAgentConfig } from './utils';

async function main() {
  const agentConfig = await getContextAgentConfig();

  const keys = getAllKeys(agentConfig);

  const keyInfos = await Promise.all(
    keys.map(async (key) => {
      let address = '';
      try {
        await key.fetch();
        address = key.address;
      } catch (e) {
        // Swallow error
      }
      return {
        identifier: key.identifier,
        address,
      };
    }),
  );

  console.log(JSON.stringify(keyInfos, null, 2));
}

main().catch(console.error);
