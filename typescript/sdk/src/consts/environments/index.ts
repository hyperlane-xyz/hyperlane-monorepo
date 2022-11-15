import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet3 from './testnet3.json';

export const environments = { test, testnet3, mainnet };

// Export developer-relevant addresses
export const hyperlaneCoreAddresses = objMap(
  { ...test, ...testnet3, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    interchainAccountRouter: addresses.interchainAccountRouter,
    interchainQueryRouter: addresses.interchainQueryRouter,
    create2Factory: addresses.create2Factory,
  }),
);
