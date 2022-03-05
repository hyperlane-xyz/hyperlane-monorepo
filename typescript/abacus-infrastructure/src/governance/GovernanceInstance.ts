import { xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { ChainConfig, BeaconProxy } from '@abacus-network/abacus-deploy';
import { InfraInstance } from '../instance';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from './types';

export class GovernanceInstance extends InfraInstance<GovernanceContracts> {
  async transferOwnership(owner: types.Address) {}

  static async deploy(
    domain: types.Domain,
    chains: Record<types.Domain, ChainConfig>,
    config: GovernanceConfig,
  ): Promise<GovernanceInstance> {
    const chain = chains[domain];
    // no initialize function called
    const router: BeaconProxy<xapps.GovernanceRouter> =
      await BeaconProxy.deploy(
        chain,
        new xapps.GovernanceRouter__factory(chain.signer),
        config.core[chain.name].upgradeBeaconController,
        [config.recoveryTimelock],
        [config.core[chain.name].xAppConnectionManager],
      );
    await router.proxy.transferOwnership(
      config.addresses[chain.name].recoveryManager,
    );
    const contracts = new GovernanceContracts(router);
    return new GovernanceInstance(chain, contracts);
  }

  get router(): xapps.GovernanceRouter {
    return this.contracts.router.proxy;
  }
}
