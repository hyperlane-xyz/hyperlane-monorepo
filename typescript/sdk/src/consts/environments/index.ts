import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet2 from './testnet2.json';

export const environments = { test, testnet2, mainnet };

// Export developer-relevant addresses
export const hyperlaneCoreAddresses = objMap(
  { ...test, ...testnet2, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
  }),
);
