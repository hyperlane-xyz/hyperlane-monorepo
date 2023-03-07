import { types } from '@hyperlane-xyz/utils';

import { CoreAddresses } from '../../core';
import { ChainMap } from '../../types';
import { objMap } from '../../utils';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet from './testnet.json';

export const environments = { test, testnet, mainnet };

/*
type HyperlanceContractAddresses = CoreAddresses & MiddlewareAddresses & IgpAddresses &
  mailbox: types.Address;
  multisigIsm: types.Address;
  interchainGasPaymaster: types.Address;
  interchainAccountRouter?: types.Address;
  interchainQueryRouter?: types.Address;
  create2Factory: types.Address;
};
*/

// Export developer-relevant addresses
export const hyperlaneCoreAddresses = objMap(
  { ...testnet, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    proxyAdmin: addresses.proxyAdmin,
    validatorAnnounce: addresses.validatorAnnounce,
  }),
) as ChainMap<CoreAddresses>;

/*
// Export developer-relevant addresses
export const hyperlaneMiddlewareAddresses = objMap(
  { ...testnet, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    interchainAccountRouter: undefined,
    interchainQueryRouter: undefined,
    create2Factory: addresses.create2Factory,
  }),
) as ChainMap<CoreAddresses>;
*/
