import { ethers } from 'ethers';

import { proxyFactoryFactories } from './contracts.js';
import { ProxyFactoryFactoriesAddresses } from './schemas.js';

/**
 * Creates a default ProxyFactoryFactoriesAddresses object with all values set to ethers.constants.AddressZero.
 * @returns {ProxyFactoryFactoriesAddresses} An object with all factory addresses set to AddressZero.
 */
export function createDefaultProxyFactoryFactories(): ProxyFactoryFactoriesAddresses {
  const defaultAddress = ethers.constants.AddressZero;
  return Object.keys(proxyFactoryFactories).reduce((acc, key) => {
    acc[key as keyof ProxyFactoryFactoriesAddresses] = defaultAddress; // Type assertion added here
    return acc;
  }, {} as ProxyFactoryFactoriesAddresses);
}
