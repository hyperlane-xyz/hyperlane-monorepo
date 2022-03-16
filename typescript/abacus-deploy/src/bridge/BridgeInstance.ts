import {
  ETHHelper,
  ETHHelper__factory,
  BridgeRouter,
  BridgeRouter__factory,
  BridgeToken,
  BridgeToken__factory,
} from '@abacus-network/apps';
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

    const token: BeaconProxy<BridgeToken> = await BeaconProxy.deploy(
      chain,
      new BridgeToken__factory(chain.signer),
      core.upgradeBeaconController,
      [],
      [],
    );

    const router: BeaconProxy<BridgeRouter> = await BeaconProxy.deploy(
      chain,
      new BridgeRouter__factory(chain.signer),
      core.upgradeBeaconController,
      [],
      [token.beacon.address, core.xAppConnectionManager],
    );

    const weth = config.weth[chain.name];
    if (weth) {
      const deployer = new ContractDeployer(chain);
      const helper: ETHHelper = await deployer.deploy(
        new ETHHelper__factory(chain.signer),
        weth,
        router.address,
      );
      const contracts = new BridgeContracts(router, token, helper);
      return new BridgeInstance(chain, contracts);
    }
    const contracts = new BridgeContracts(router, token);
    return new BridgeInstance(chain, contracts);
  }

  get token(): BridgeToken {
    return this.contracts.token.contract;
  }

  get router(): BridgeRouter {
    return this.contracts.router.contract;
  }

  get helper(): ETHHelper | undefined {
    return this.contracts.helper;
  }

  get verificationInput(): VerificationInput {
    let input: VerificationInput = [];
    input = input.concat(
      getBeaconProxyVerificationInput(
        'BridgeToken',
        this.contracts.token,
        BridgeToken__factory.bytecode,
      ),
    );
    input = input.concat(
      getBeaconProxyVerificationInput(
        'BridgeRouter',
        this.contracts.router,
        BridgeRouter__factory.bytecode,
      ),
    );
    if (this.helper) {
      input.push(
        getContractVerificationInput(
          'ETH Helper',
          this.helper,
          ETHHelper__factory.bytecode,
        ),
      );
    }
    return input;
  }
}
