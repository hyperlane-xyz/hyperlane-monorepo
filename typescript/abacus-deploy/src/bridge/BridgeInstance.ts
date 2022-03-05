import { xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import {
  ContractDeployer,
  ChainConfig,
  BeaconProxy,
} from '@abacus-network/abacus-deploy';
import { BridgeContracts } from './BridgeContracts';
import { BridgeConfig } from './types';
import { RouterInstance } from '../router';

export class BridgeInstance extends RouterInstance<BridgeContracts> {
  async transferOwnership(owner: types.Address) {
    const tx = await this.router.transferOwnership(owner, this.chain.overrides);
    await tx.wait(this.chain.confirmations);
  }

  static async deploy(
    domain: types.Domain,
    chains: Record<types.Domain, ChainConfig>,
    config: BridgeConfig,
  ): Promise<BridgeInstance> {
    const chain = chains[domain];

    const token: BeaconProxy<xapps.BridgeToken> = await BeaconProxy.deploy(
      chain,
      new xapps.BridgeToken__factory(chain.signer),
      config.core[chain.name].upgradeBeaconController,
      [],
      [],
    );

    const router: BeaconProxy<xapps.BridgeRouter> = await BeaconProxy.deploy(
      chain,
      new xapps.BridgeRouter__factory(chain.signer),
      config.core[chain.name].upgradeBeaconController,
      [],
      [token.beacon.address, config.core[chain.name].xAppConnectionManager],
    );

    if (config.addresses[chain.name]) {
      const deployer = new ContractDeployer(chain);
      const helper: xapps.ETHHelper = await deployer.deploy(
        new xapps.ETHHelper__factory(chain.signer),
        config.addresses[chain.name].weth,
        router.address,
      );
      const contracts = new BridgeContracts(router, token, helper);
      return new BridgeInstance(chain, contracts);
    }
    const contracts = new BridgeContracts(router, token);
    return new BridgeInstance(chain, contracts);
  }

  get token(): xapps.BridgeToken {
    return this.contracts.token.proxy;
  }

  get router(): xapps.BridgeRouter {
    return this.contracts.router.proxy;
  }

  get helper(): xapps.ETHHelper | undefined {
    return this.contracts.helper;
  }
}
