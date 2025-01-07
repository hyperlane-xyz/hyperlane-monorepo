import { HttpServer } from '@hyperlane-xyz/registry';

import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';

import { getArgs } from './agent-utils.js';

async function main() {
  const { environment } = await getArgs().argv;

  const registry =
    environment === 'mainnet3'
      ? await getMainnet3Registry()
      : await getTestnet4Registry();

  const server = new HttpServer(registry);
  await server.start();
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
