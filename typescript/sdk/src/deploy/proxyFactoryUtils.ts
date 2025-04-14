import { ethers } from 'ethers';

import { objMapEntries } from '@hyperlane-xyz/utils';

import { proxyFactoryFactories } from './contracts.js';
import { ProxyFactoryFactoriesAddresses } from './types.js';

/**
 * Creates a default ProxyFactoryFactoriesAddresses object with all values set to ethers.constants.AddressZero.
 * @returns {ProxyFactoryFactoriesAddresses} An object with all factory addresses set to AddressZero.
 */
export function createDefaultProxyFactoryFactories(): ProxyFactoryFactoriesAddresses {
  const defaultAddress = ethers.constants.AddressZero;
  return Object.fromEntries(
    objMapEntries(proxyFactoryFactories, () => defaultAddress),
  ) as ProxyFactoryFactoriesAddresses;
}
