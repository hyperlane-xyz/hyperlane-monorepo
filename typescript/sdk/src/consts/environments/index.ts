import { CoreAddresses } from '../../core/contracts';
import { IgpAddresses } from '../../gas/contracts';
import { ChainMap } from '../../types';
import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet from './testnet.json';

export const hyperlaneEnvironments = { test, testnet, mainnet };

// TODO: Add middleware addresses
export type HyperlaneContractAddresses = CoreAddresses & IgpAddresses;

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

export const hyperlaneContractAddresses = objMap(
  { ...testnet, ...mainnet },
  (_chain, addresses) => ({
    mailbox: addresses.mailbox.proxy,
    multisigIsm: addresses.multisigIsm,
    proxyAdmin: addresses.proxyAdmin,
    validatorAnnounce: addresses.validatorAnnounce,
    interchainGasPaymaster: addresses.interchainGasPaymaster.proxy,
    storageGasOracle: addresses.storageGasOracle,
    defaultIsmInterchainGasPaymaster:
      addresses.defaultIsmInterchainGasPaymaster,
    //interchainAccountRouter: undefined,
    //interchainQueryRouter: undefined,
  }),
) as ChainMap<HyperlaneContractAddresses>;
