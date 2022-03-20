import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '../config';
import { BeaconProxy } from '../common';
import { RouterInstance } from '../router';
import {
  getBeaconProxyVerificationInput,
  VerificationInput,
} from '../verification';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from './types';

export class GovernanceInstance extends RouterInstance<GovernanceContracts> {
  async transferOwnership(owner: types.Address) {}

  static async deploy(
    domain: types.Domain,
    chains: Record<types.Domain, ChainConfig>,
    config: GovernanceConfig,
  ): Promise<GovernanceInstance> {
    const chain = chains[domain];
    const core = config.core[chain.name];
    if (core === undefined) throw new Error('could not find core');

    const router: BeaconProxy<GovernanceRouter> = await BeaconProxy.deploy(
      chain,
      new GovernanceRouter__factory(chain.signer),
      core.upgradeBeaconController,
      [config.recoveryTimelock],
      [core.xAppConnectionManager],
    );

    const addresses = config.addresses[chain.name];
    if (addresses === undefined) throw new Error('could not find addresses');
    await router.contract.transferOwnership(addresses.recoveryManager);

    const contracts = new GovernanceContracts(router);
    return new GovernanceInstance(chain, contracts);
  }

  get router(): GovernanceRouter {
    return this.contracts.router.contract;
  }

  get verificationInput(): VerificationInput {
    return getBeaconProxyVerificationInput(
      'GovernanceRouter',
      this.contracts.router,
      GovernanceRouter__factory.bytecode,
    );
  }
}
