import { types } from '@hyperlane-xyz/utils';

import { LooseChainMap } from '../../types';
import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet2 from './testnet2.json';

export const environments = { test, testnet2, mainnet };

type HyperlaneCoreAddressMap = LooseChainMap<{
  outbox: types.Address;
  connectionManager: types.Address;
  interchainGasPaymaster: types.Address;
  interchainAccountRouter: types.Address;
  interchainQueryRouter: types.Address;
  create2Factory: types.Address;
  inboxes: Record<string, types.Address>;
}>;

// Export developer-relevant addresses
export const hyperlaneCoreAddresses = objMap(
  { ...test, ...testnet2, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    interchainAccountRouter: addresses.interchainAccountRouter,
    interchainQueryRouter: addresses.interchainQueryRouter,
    create2Factory: addresses.create2Factory,
  }),
) as HyperlaneCoreAddressMap;
