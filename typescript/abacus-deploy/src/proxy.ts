import { ethers } from 'ethers';
import { core } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';

import { ChainConfig, ProxiedAddress } from './types';
import { ContractDeployer } from './deployer';

export class BeaconProxy<T extends ethers.Contract> {
  constructor(
    public readonly implementation: T,
    public readonly proxy: T,
    public readonly beacon: core.UpgradeBeacon,
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
    const beacon: core.UpgradeBeacon = await deployer.deploy(
      new core.UpgradeBeacon__factory(chain.signer),
      implementation.address,
      ubcAddress,
    );

    const initData = implementation.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    const proxy: core.UpgradeBeaconProxy = await deployer.deploy(
      new core.UpgradeBeaconProxy__factory(chain.signer),
      beacon.address,
      initData,
    );
    // proxy wait(x) implies implementation and beacon wait(>=x)
    // due to nonce ordering
    await proxy.deployTransaction.wait(chain.confirmations);
    return new BeaconProxy(
      implementation as T,
      factory.attach(proxy.address) as T,
      beacon,
    );
  }

  static fromObject<T extends ethers.Contract>(
    addresses: ProxiedAddress,
    abi: any,
    provider: ethers.providers.JsonRpcProvider,
  ): BeaconProxy<T> {
    const implementation = new ethers.Contract(
      addresses.implementation,
      abi,
      provider,
    ) as T;
    const proxy = new ethers.Contract(addresses.proxy, abi, provider) as T;
    const beacon = core.UpgradeBeacon__factory.connect(
      addresses.beacon,
      provider,
    );
    return new BeaconProxy<T>(implementation, proxy, beacon);
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
    const proxy = await deployer.deploy(
      new core.UpgradeBeaconProxy__factory(chain.signer),
      this.beacon.address,
      initData,
    );

    return new BeaconProxy(
      this.implementation,
      this.proxy.attach(proxy.address) as T,
      this.beacon,
    );
  }

  get address(): types.Address {
    return this.proxy.address;
  }

  toObject(): ProxiedAddress {
    return {
      proxy: this.proxy.address,
      implementation: this.implementation.address,
      beacon: this.beacon.address,
    };
  }
}
