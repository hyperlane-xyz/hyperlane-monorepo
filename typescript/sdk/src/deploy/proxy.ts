import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';
import { eqAddress } from '@hyperlane-xyz/utils/dist/src/utils';

export async function proxyImplementation(
  provider: ethers.providers.Provider,
  proxy: types.Address,
): Promise<types.Address> {
  // Hardcoded storage slot for implementation per EIP-1967
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
  // Hardcoded storage slot for admin per EIP-1967
  const storageValue = await provider.getStorageAt(
    proxy,
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  );
  return ethers.utils.getAddress(storageValue.slice(26));
}

export async function isProxy(
  provider: ethers.providers.Provider,
  proxy: types.Address,
): Promise<boolean> {
  const admin = await proxyAdmin(provider, proxy);
  return !eqAddress(admin, ethers.constants.AddressZero);
}
