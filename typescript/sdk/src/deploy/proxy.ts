import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { BeaconProxyAddresses } from '../proxy';
import { ChainName } from '../types';

import { CheckerViolation } from './types';

export interface UpgradeBeaconViolation extends CheckerViolation {
  type: BeaconProxyAddresses['kind'];
  data: {
    proxiedAddress: BeaconProxyAddresses;
    name: string;
  };
  actual: string;
  expected: string;
}

export async function upgradeBeaconImplementation(
  provider: ethers.providers.Provider,
  beacon: types.Address,
): Promise<types.Address> {
  // TODO: This should check the correct upgrade beacon controller
  const storageValue = await provider.getStorageAt(beacon, 0);
  return ethers.utils.getAddress(storageValue.slice(26));
}

export function upgradeBeaconViolation<Chain extends ChainName>(
  chain: Chain,
  name: string,
  proxiedAddress: BeaconProxyAddresses,
  actual: types.Address,
): UpgradeBeaconViolation {
  return {
    chain,
    type: proxiedAddress.kind,
    actual,
    expected: proxiedAddress.implementation,
    data: {
      name,
      proxiedAddress,
    },
  };
}
