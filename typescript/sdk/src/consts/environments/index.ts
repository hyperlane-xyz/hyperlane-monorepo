import { Address } from '@hyperlane-xyz/utils/dist/src/types';

import { ForgivingCompleteChainMap } from '../../types';
import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet2 from './testnet2.json';

export const environments = {
  test,
  testnet2,
  mainnet,
};

// Export developer-relevant addresses
export const hyperlaneCoreAddresses = objMap(
  { ...testnet2, ...mainnet },
  (_chain, addresses) => ({
    outbox: addresses.outbox.proxy,
    connectionManager: addresses.connectionManager,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    interchainAccountRouter: addresses.interchainAccountRouter,
    interchainQueryRouter: addresses.interchainQueryRouter,
    create2Factory: addresses.create2Factory,
    inboxes: objMap(
      // @ts-ignore
      addresses.inboxes,
      (_remoteChain, inboxAddresses) => inboxAddresses.inbox.proxy,
    ),
  }),
) as ForgivingCompleteChainMap<{
  outbox: Address;
  connectionManager: Address;
  interchainGasPaymaster: Address;
  interchainAccountRouter: Address;
  interchainQueryRouter: Address;
  create2Factory: Address;
  inboxes: Record<string, Address>;
}>;
