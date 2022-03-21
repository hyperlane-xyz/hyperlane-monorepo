import { ethers } from 'ethers';
import {
  UpgradeBeacon,
  UpgradeBeacon__factory,
  UpgradeBeaconProxy,
  UpgradeBeaconProxy__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';

export type ProxiedAddress = {
  proxy: types.Address;
  implementation: types.Address;
  beacon: types.Address;
};

export class BeaconProxy<T extends ethers.Contract> {
  constructor(
    public readonly implementation: T,
    public readonly proxy: UpgradeBeaconProxy,
    public readonly beacon: UpgradeBeacon,
    public readonly contract: T,
  ) {}


  static fromObject<T extends ethers.Contract>(
    addresses: ProxiedAddress,
    abi: any,
    signer: ethers.Signer,
  ): BeaconProxy<T> {
    const implementation = new ethers.Contract(
      addresses.implementation,
      abi,
      signer,
    ) as T;
    const proxy = UpgradeBeaconProxy__factory.connect(addresses.proxy, signer);
    const beacon = UpgradeBeacon__factory.connect(addresses.beacon, signer);
    const contract = new ethers.Contract(addresses.proxy, abi, signer) as T;
    return new BeaconProxy<T>(implementation, proxy, beacon, contract);
  }

  get address(): types.Address {
    return this.contract.address;
  }

  toObject(): ProxiedAddress {
    return {
      proxy: this.proxy.address,
      implementation: this.implementation.address,
      beacon: this.beacon.address,
    };
  }
}
