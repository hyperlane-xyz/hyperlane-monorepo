import { getAllKeys } from '../src/agents/key-utils';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);

  const keys = getAllKeys(config.agent);

  const keyInfos = await Promise.all(
    keys.map(async (key) => {
      let address = '';
      try {
        await key.fetch();
        address = key.address;
      } catch (e) {}
      return {
        identifier: key.identifier,
        address,
      };
    }),
  );

  console.log(JSON.stringify(keyInfos, null, 2));
}

main().catch(console.error);
