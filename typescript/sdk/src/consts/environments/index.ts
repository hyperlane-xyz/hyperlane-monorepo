import { types } from '@hyperlane-xyz/utils';

import { CoreContractAddresses } from '../../core/contracts';
import { ChainMap } from '../../types';
import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet from './testnet.json';

// Hmm, there doesn't appear to be a type for this....
export const environments = { test, testnet, mainnet };

export type HyperlaneContractAddresses = CoreContractAddresses & {
  interchainAccountRouter?: types.Address;
  interchainQueryRouter?: types.Address;
  create2Factory: types.Address;
};

type HyperlaneContractAddressesMap = ChainMap<HyperlaneContractAddresses>;

// Export developer-relevant addresses
export const hyperlaneContractAddresses = objMap(
  { ...testnet, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    create2Factory: addresses.create2Factory,
    validatorAnnounce: addresses.validatorAnnounce,
    proxyAdmin: addresses.proxyAdmin,
  }),
) as HyperlaneContractAddressesMap;

// Okay, so there are all these different contracts
// Fundamental:
//   mailbox
//   proxyAdmin?
// Middlewares:
//   iqs
//   ica
// InterchainSecurityModules
//   really could put anything in here
// InterchainGasPaymasters:
//   really could put anything in here
// Testing
//   TestRecipient
// Infra
//   create2Factory
