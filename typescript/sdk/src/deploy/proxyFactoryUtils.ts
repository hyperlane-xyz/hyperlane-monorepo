import { ZeroAddress } from 'ethers';

import { objMap } from '@hyperlane-xyz/utils';

import { proxyFactoryFactories } from './contracts.js';
import { ProxyFactoryFactoriesAddresses } from './types.js';

/**
 * Creates a default ProxyFactoryFactoriesAddresses object with all values set to ZeroAddress.
 * @returns {ProxyFactoryFactoriesAddresses} An object with all factory addresses set to AddressZero.
 */
export function createDefaultProxyFactoryFactories(): ProxyFactoryFactoriesAddresses {
  const defaultAddress = ZeroAddress;
  return objMap(
    proxyFactoryFactories,
    () => defaultAddress,
  ) as ProxyFactoryFactoriesAddresses;
}
