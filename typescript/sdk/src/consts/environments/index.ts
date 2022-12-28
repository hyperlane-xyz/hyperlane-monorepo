import { types } from '@hyperlane-xyz/utils';

import { LooseChainMap } from '../../types';
import { objMap } from '../../utils/objects';

import mainnet2 from './mainnet2.json';
import test from './test.json';
import testnet3 from './testnet3.json';

export const environments = { test, testnet3, mainnet2 };

type HyperlaneCoreAddressMap = LooseChainMap<{
  mailbox: types.Address;
  multisigIsm: types.Address;
  interchainGasPaymaster: types.Address;
  //interchainAccountRouter: types.Address;
  //interchainQueryRouter: types.Address;
  create2Factory: types.Address;
}>;

// Export developer-relevant addresses
export const hyperlaneCoreAddresses = objMap(
  { ...testnet3, ...mainnet2 },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    //interchainAccountRouter: addresses.interchainAccountRouter,
    //interchainQueryRouter: addresses.interchainQueryRouter,
    create2Factory: addresses.create2Factory,
  }),
) as HyperlaneCoreAddressMap;
