import { BytesLike, ethers } from 'ethers';

import { core } from '@abacus-network/ts-interface';
import { Deploy } from '../deploy';
import { CoreDeploy } from '../core/CoreDeploy';
import { ProxiedAddress } from '../config/addresses';

export class BeaconProxy<T extends ethers.Contract> {
  constructor(
    public readonly implementation: T,
    public readonly proxy: T,
    public readonly beacon: core.UpgradeBeacon,
  ) {
  }

  /**
   * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
   *
   * @param T - The contract
   */
  static async deploy<T extends ethers.Contract>(chain: ChainConfig, factory: ethers.ContractFactory, deployArgs: any[], initArgs: any[]): Promise<BeaconProxy<T>> {
    const deployer = new ContractDeployer(chain, false);
    const implementation = await deployer.deploy(factory, ...deployArgs)
    const beacon = await deployer.deploy(core.UpgradeBeacon__factory, ubcAddress)
    const proxy = await deployer.deploy(core.UpgradeBeaconProxy__factory, beacon.address, ...initArgs)
    // proxy wait(x) implies implementation and beacon wait(>=x)
    // due to nonce ordering
    await proxy.deployTransaction.wait(chain.confirmations);
    return new BeaconProxy(
      implementation as T,
      factory.attach(proxy.address) as T,
      beacon,
    );
  }

  /**
   * Sets up a new proxy with the same beacon and implementation
   *
   * @param T - The contract
   */
  async duplicate(chain: ChainConfig, initArgs: any[]): Promise<BeaconProxy<T>> {
    const deployer = new ContractDeployer(chain, true);
    const proxy = await deployer.deploy(core.UpgradeBeaconProxy__factory, this.beacon.address, ...initArgs)

    return new BeaconProxy(
      this.implementation,
      prev.proxy.attach(proxy.address) as T,
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
