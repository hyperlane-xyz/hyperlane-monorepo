import { HttpServer } from '@hyperlane-xyz/registry';

import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';

import { getArgs } from './agent-utils.js';

async function main() {
  const { environment } = await getArgs().argv;

  const getRegistry =
    environment === 'mainnet3' ? getMainnet3Registry : getTestnet4Registry;

  new HttpServer(getRegistry).start(3000, 5 * 60 * 1000);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
