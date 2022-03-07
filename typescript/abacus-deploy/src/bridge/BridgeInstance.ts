import { xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '../config';
import { ContractDeployer, BeaconProxy } from '../common';
import { BridgeContracts } from './BridgeContracts';
import { BridgeConfig } from './types';
import { RouterInstance } from '../router';
import {
  getContractVerificationInput,
  getBeaconProxyVerificationInput,
  VerificationInput,
} from '../verification';

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
    const core = config.core[chain.name];
    if (core === undefined) throw new Error('could not find core');

    const token: BeaconProxy<xapps.BridgeToken> = await BeaconProxy.deploy(
      chain,
      new xapps.BridgeToken__factory(chain.signer),
      core.upgradeBeaconController,
      [],
      [],
    );

    const router: BeaconProxy<xapps.BridgeRouter> = await BeaconProxy.deploy(
      chain,
      new xapps.BridgeRouter__factory(chain.signer),
      core.upgradeBeaconController,
      [],
      [token.beacon.address, core.xAppConnectionManager],
    );

    const weth = config.weth[chain.name];
    if (weth) {
      const deployer = new ContractDeployer(chain);
      const helper: xapps.ETHHelper = await deployer.deploy(
        new xapps.ETHHelper__factory(chain.signer),
        weth,
        router.address,
      );
      const contracts = new BridgeContracts(router, token, helper);
      return new BridgeInstance(chain, contracts);
    }
    const contracts = new BridgeContracts(router, token);
    return new BridgeInstance(chain, contracts);
  }

  get token(): xapps.BridgeToken {
    return this.contracts.token.contract;
  }

  get router(): xapps.BridgeRouter {
    return this.contracts.router.contract;
  }

  get helper(): xapps.ETHHelper | undefined {
    return this.contracts.helper;
  }

  get verificationInput(): VerificationInput {
    let input: VerificationInput = [];
    input = input.concat(
      getBeaconProxyVerificationInput(
        'BridgeToken',
        this.contracts.token,
        xapps.BridgeToken__factory.bytecode,
      ),
    );
    input = input.concat(
      getBeaconProxyVerificationInput(
        'BridgeRouter',
        this.contracts.router,
        xapps.BridgeRouter__factory.bytecode,
      ),
    );
    if (this.helper) {
      input.push(
        getContractVerificationInput(
          'ETH Helper',
          this.helper,
          xapps.ETHHelper__factory.bytecode,
        ),
      );
    }
    return input;
  }
}
