import { PopulatedTransaction, constants } from 'ethers';
import { Logger } from 'pino';

import {
  CrossCollateralRouter__factory,
  Mailbox__factory,
  PredicateCrossCollateralRouterWrapper__factory,
  PredicateRouterWrapper__factory,
  StaticAggregationHookFactory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { TokenType } from '../token/config.js';
import { PredicateWrapperConfig } from '../token/types.js';
import { ChainName } from '../types.js';

export interface PredicateWrapperDeploymentResult {
  wrapperAddress: Address;
  aggregationHookAddress: Address;
  setHookTx: PopulatedTransaction;
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
    tokenType?: TokenType,
  ): Promise<Address> {
    const signer = this.multiProvider.getSigner(chain);

    const isCrossCollateral = tokenType === TokenType.crossCollateral;
    const wrapperName = isCrossCollateral
      ? 'PredicateCrossCollateralRouterWrapper'
      : 'PredicateRouterWrapper';

    this.logger.info(
      {
        chain,
        warpRoute: warpRouteAddress,
        registry: config.predicateRegistry,
        tokenType,
        wrapperType: wrapperName,
      },
      `Deploying ${wrapperName}`,
    );

    // Deploy the appropriate wrapper based on token type
    // Token address is fetched from warpRoute.token() in constructor
    const wrapper = isCrossCollateral
      ? await new PredicateCrossCollateralRouterWrapper__factory(signer).deploy(
          warpRouteAddress,
          config.predicateRegistry,
          config.policyId,
        )
      : await new PredicateRouterWrapper__factory(signer).deploy(
          warpRouteAddress,
          config.predicateRegistry,
          config.policyId,
        );
    await wrapper.deployed();

    // Transfer wrapper ownership to the warp route owner so that admin functions
    // (setPolicyID, setRegistry, withdrawETH) are controlled by the same key/multisig
    // that owns the warp route, not the ephemeral deployer key.
    // Use the explicit owner from config rather than reading from on-chain, because
    // during initial deployment the on-chain owner is still the deployer signer
    // (transferOwnership hasn't run yet).
    const routeOwner = config.owner;
    await this.multiProvider.handleTx(
      chain,
      wrapper.transferOwnership(routeOwner),
    );

    this.logger.info(
      {
        chain,
        address: wrapper.address,
        owner: routeOwner,
        wrapperType: wrapperName,
      },
      `${wrapperName} deployed and ownership transferred`,
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

  /**
   * Deploys the predicate wrapper and aggregation hook on-chain as a side effect, then
   * returns the populated setHook transaction for the caller to include in its transaction
   * array. This intentionally mirrors the pattern used by EvmHookModule and EvmIsmModule,
   * where contract deployments happen eagerly during update planning.
   *
   * Known limitation: if the returned setHookTx is never submitted (e.g. dry-run or
   * cancellation), the deployed PredicateRouterWrapper is orphaned. The aggregation hook
   * is safe because StaticAggregationHookFactory uses CREATE2 (idempotent). Eliminating
   * the wrapper orphan risk requires a CREATE2 factory for PredicateRouterWrapper, which
   * is a future contract-level improvement.
   *
   * @param existingHookOverride - When provided, skips the on-chain hook() read and uses
   *   this address instead. Pass the pending new hook address when a hook update is being
   *   applied in the same update() call to avoid wrapping a stale on-chain hook.
   */
  async deployAndConfigure(
    chain: ChainName,
    warpRouteAddress: Address,
    config: PredicateWrapperConfig,
    tokenType?: TokenType,
    existingHookOverride?: Address,
  ): Promise<PredicateWrapperDeploymentResult> {
    const signer = this.multiProvider.getSigner(chain);

    // Connect to the appropriate router type
    const isCrossCollateral = tokenType === TokenType.crossCollateral;
    const warpRoute = isCrossCollateral
      ? CrossCollateralRouter__factory.connect(warpRouteAddress, signer)
      : TokenRouter__factory.connect(warpRouteAddress, signer);

    // Use the override when provided (e.g. when a hook update is pending in the same
    // update() call and the on-chain value would be stale).
    const existingHook = existingHookOverride ?? (await warpRoute.hook());

    const wrapperAddress = await this.deployPredicateWrapper(
      chain,
      warpRouteAddress,
      config,
      tokenType,
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

    const setHookTx = await warpRoute.populateTransaction.setHook(
      aggregationHookAddress,
    );

    return {
      wrapperAddress,
      aggregationHookAddress,
      setHookTx,
    };
  }
}
