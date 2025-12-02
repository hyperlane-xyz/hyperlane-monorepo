import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { IRegistry } from '@hyperlane-xyz/registry';
import { assert } from '@hyperlane-xyz/utils';

import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';

import { getArgs } from './agent-utils.js';

async function main() {
  const { environment, port } = await getArgs()
    .describe('port', 'port to deploy on')
    .default({ port: 3333, environment: 'mainnet3' }).argv;

  const environmentToRegistry: Record<string, () => Promise<IRegistry>> = {
    mainnet3: getMainnet3Registry,
    testnet4: getTestnet4Registry,
  };

  const getRegistry = environmentToRegistry[environment];
  assert(getRegistry, `Uninitialized registry for environment: ${environment}`);

  const httpRegistryServer = await HttpServer.create(async () => getRegistry());
  await httpRegistryServer.start(port.toString());
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
