import { getAllCloudAgentKeys } from '../src/agents/key-utils.js';

import { getArgs, withContext, withProtocol } from './agent-utils.js';
import { getConfigsBasedOnArgs } from './core-utils.js';

async function main() {
  const argv = await withProtocol(withContext(getArgs())).argv;

  const { agentConfig } = await getConfigsBasedOnArgs(argv);

  const keys = getAllCloudAgentKeys(agentConfig);
  const keyInfoPromises = keys.map(async (key) => {
    let address = undefined;
    try {
      await key.fetch();
      address = key.addressForProtocol(argv.protocol);
    } catch (e) {
      // Swallow error
      console.error('Error getting address', { key: key.identifier, e });
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
