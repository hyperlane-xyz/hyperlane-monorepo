import { ethers } from 'ethers';
import {
  UpgradeBeacon,
  UpgradeBeacon__factory,
  UpgradeBeaconProxy,
  UpgradeBeaconProxy__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { ChainConfig } from '../config';
import { ContractDeployer } from './ContractDeployer';

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

  /**
   * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
   *
   * @param T - The contract
   */
  static async deploy<T extends ethers.Contract>(
    chain: ChainConfig,
    factory: ethers.ContractFactory,
    ubcAddress: types.Address,
    deployArgs: any[],
    initArgs: any[],
  ): Promise<BeaconProxy<T>> {
    const deployer = new ContractDeployer(chain, false);
    const implementation: T = await deployer.deploy(factory, ...deployArgs);
    const beacon: UpgradeBeacon = await deployer.deploy(
      new UpgradeBeacon__factory(chain.signer),
      implementation.address,
      ubcAddress,
    );

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: UpgradeBeaconProxy = await deployer.deploy(
      new UpgradeBeaconProxy__factory(chain.signer),
      beacon.address,
      initData,
    );
    // proxy wait(x) implies implementation and beacon wait(>=x)
    // due to nonce ordering
    await proxy.deployTransaction.wait(chain.confirmations);
    return new BeaconProxy(
      implementation as T,
      proxy,
      beacon,
      factory.attach(proxy.address) as T,
    );
  }

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

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   * @param T - The contract
   */
  async duplicate(
    chain: ChainConfig,
    initArgs: any[],
  ): Promise<BeaconProxy<T>> {
    const deployer = new ContractDeployer(chain);
    const initData = this.implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: UpgradeBeaconProxy = await deployer.deploy(
      new UpgradeBeaconProxy__factory(chain.signer),
      this.beacon.address,
      initData,
    );

    return new BeaconProxy(
      this.implementation,
      proxy,
      this.beacon,
      this.contract.attach(proxy.address) as T,
    );
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
