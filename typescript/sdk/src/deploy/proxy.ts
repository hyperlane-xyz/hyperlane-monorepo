import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { TransparentProxyAddresses } from '../proxy';
import { ChainName } from '../types';

import { CheckerViolation } from './types';

export interface ProxyViolation extends CheckerViolation {
  type: TransparentProxyAddresses['kind'];
  data: {
    proxyAddresses: TransparentProxyAddresses;
    name: string;
  };
  actual: string;
  expected: string;
}

export async function proxyImplementation(
  provider: ethers.providers.Provider,
  proxy: types.Address,
): Promise<types.Address> {
  const storageValue = await provider.getStorageAt(
    proxy,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  );
  return ethers.utils.getAddress(storageValue.slice(26));
}

export async function proxyAdmin(
  provider: ethers.providers.Provider,
  proxy: types.Address,
): Promise<types.Address> {
  const storageValue = await provider.getStorageAt(
    proxy,
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  );
  return ethers.utils.getAddress(storageValue.slice(26));
}

export function proxyViolation<Chain extends ChainName>(
  chain: Chain,
  name: string,
  proxyAddresses: TransparentProxyAddresses,
  actual: types.Address,
): ProxyViolation {
  return {
    chain,
    type: proxyAddresses.kind,
    actual,
    expected: proxyAddresses.implementation,
    data: {
      name,
      proxyAddresses,
    },
  };
}
