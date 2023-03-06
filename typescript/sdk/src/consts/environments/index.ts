import { types } from '@hyperlane-xyz/utils';

import { CoreContractAddresses } from '../../core/contracts';
import { flattenProxyAddresses } from '../../proxy';
import { ChainMap } from '../../types';
import { objMap } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet from './testnet.json';

export type HyperlaneContractAddresses = CoreContractAddresses & {
  interchainAccountRouter?: types.Address;
  interchainQueryRouter?: types.Address;
  create2Factory?: types.Address;
};

type HyperlaneContractAddressesMap = ChainMap<HyperlaneContractAddresses>;

export const environments: Record<string, HyperlaneContractAddressesMap> = {
  test,
  testnet,
  mainnet,
};

// Export developer-relevant addresses
export const hyperlaneContractAddresses = objMap(
  { ...testnet, ...mainnet },
  (_chain, addresses: HyperlaneContractAddresses) => ({
    mailbox: flattenProxyAddresses(addresses.mailbox),
    multisigIsm: addresses.multisigIsm,
    interchainGasPaymaster: flattenProxyAddresses(
      addresses.interchainGasPaymaster,
    ),
    defaultIsmInterchainGasPaymaster:
      addresses.defaultIsmInterchainGasPaymaster,
    create2Factory: addresses.create2Factory,
    validatorAnnounce: addresses.validatorAnnounce,
    proxyAdmin: addresses.proxyAdmin,
    interchainAccountRouter: addresses.interchainAccountRouter,
    interchainQueryRouter: addresses.interchainQueryRouter,
  }),
) as HyperlaneContractAddressesMap;
