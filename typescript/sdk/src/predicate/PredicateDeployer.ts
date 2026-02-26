import { constants } from 'ethers';
import { Logger } from 'pino';

import {
  Mailbox__factory,
  PredicateRouterWrapper__factory,
  StaticAggregationHookFactory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { PredicateWrapperConfig } from '../token/types.js';
import { ChainName } from '../types.js';

export interface PredicateWrapperDeploymentResult {
  wrapperAddress: Address;
  aggregationHookAddress: Address;
}

export class PredicateWrapperDeployer {
  private readonly logger: Logger;

  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly staticAggregationHookFactory: StaticAggregationHookFactory,
    logger?: Logger,
  ) {
    this.logger =
      logger ?? rootLogger.child({ module: 'PredicateWrapperDeployer' });
  }

  async deployPredicateWrapper(
    chain: ChainName,
    warpRouteAddress: Address,
    config: PredicateWrapperConfig,
  ): Promise<Address> {
    const signer = this.multiProvider.getSigner(chain);

    this.logger.info(
      {
        chain,
        warpRoute: warpRouteAddress,
        registry: config.predicateRegistry,
      },
      'Deploying PredicateRouterWrapper',
    );

    // Token address is fetched from warpRoute.token() in constructor
    const wrapper = await new PredicateRouterWrapper__factory(signer).deploy(
      warpRouteAddress,
      config.predicateRegistry,
      config.policyId,
    );
    await wrapper.deployed();

    this.logger.info(
      { chain, address: wrapper.address },
      'PredicateRouterWrapper deployed',
    );
    return wrapper.address;
  }

  async createAggregationHook(
    chain: ChainName,
    predicateWrapperAddress: Address,
    existingHookAddress: Address,
  ): Promise<Address> {
    const signer = this.multiProvider.getSigner(chain);

    this.logger.info(
      {
        chain,
        predicateWrapper: predicateWrapperAddress,
        existingHook: existingHookAddress,
      },
      'Creating aggregation hook',
    );

    const hooks = [predicateWrapperAddress, existingHookAddress];
    const threshold = hooks.length;

    const factory = this.staticAggregationHookFactory.connect(signer);

    const existingAddress = await factory['getAddress(address[],uint8)'](
      hooks,
      threshold,
    );
    const code = await this.multiProvider
      .getProvider(chain)
      .getCode(existingAddress);

    let aggregationHookAddress: Address;
    if (code === '0x') {
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const tx = await factory['deploy(address[],uint8)'](
        hooks,
        threshold,
        overrides,
      );
      await this.multiProvider.handleTx(chain, tx);
      aggregationHookAddress = existingAddress;
    } else {
      this.logger.debug(
        { chain, address: existingAddress },
        'Recovered existing aggregation hook',
      );
      aggregationHookAddress = existingAddress;
    }

    this.logger.info(
      { chain, address: aggregationHookAddress },
      'Aggregation hook ready',
    );
    return aggregationHookAddress;
  }

  async deployAndConfigure(
    chain: ChainName,
    warpRouteAddress: Address,
    config: PredicateWrapperConfig,
  ): Promise<PredicateWrapperDeploymentResult> {
    const signer = this.multiProvider.getSigner(chain);
    const warpRoute = TokenRouter__factory.connect(warpRouteAddress, signer);

    const existingHook = await warpRoute.hook();

    const wrapperAddress = await this.deployPredicateWrapper(
      chain,
      warpRouteAddress,
      config,
    );

    let hookToAggregateWith: Address;
    if (existingHook !== constants.AddressZero) {
      hookToAggregateWith = existingHook;
    } else {
      const mailboxAddress = await warpRoute.mailbox();
      const mailbox = Mailbox__factory.connect(mailboxAddress, signer);
      hookToAggregateWith = await mailbox.defaultHook();
      this.logger.info(
        { chain, defaultHook: hookToAggregateWith },
        'Using mailbox default hook for aggregation (warp route had no existing hook)',
      );
    }

    const aggregationHookAddress = await this.createAggregationHook(
      chain,
      wrapperAddress,
      hookToAggregateWith,
    );

    this.logger.info(
      { chain, hook: aggregationHookAddress },
      'Setting hook on warp route',
    );
    const tx = await warpRoute.setHook(aggregationHookAddress);
    await this.multiProvider.handleTx(chain, tx);

    return {
      wrapperAddress,
      aggregationHookAddress,
    };
  }
}
