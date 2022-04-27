import { ChainName, ProxiedAddress } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { CheckerViolation } from './config';

export class ProxiedContract<T extends ethers.Contract> {
  constructor(
    public readonly contract: T,
    public readonly addresses: ProxiedAddress,
  ) {}

  get address() {
    return this.contract.address;
  }
}

export enum ProxyViolationType {
  UpgradeBeacon = 'UpgradeBeacon',
}

export interface UpgradeBeaconViolation extends CheckerViolation {
  type: ProxyViolationType.UpgradeBeacon;
  data: {
    proxiedAddress: ProxiedAddress;
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

export function upgradeBeaconViolation<N extends ChainName>(
  network: N,
  name: string,
  proxiedAddress: ProxiedAddress,
  actual: types.Address,
): UpgradeBeaconViolation {
  return {
    network,
    type: ProxyViolationType.UpgradeBeacon,
    actual,
    expected: proxiedAddress.implementation,
    data: {
      name,
      proxiedAddress,
    },
  };
}
