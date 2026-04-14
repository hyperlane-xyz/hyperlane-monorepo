import { PopulatedTransaction, constants } from 'ethers';
import { Logger } from 'pino';

import {
  CrossCollateralRouter__factory,
  Mailbox__factory,
  PredicateCrossCollateralRouterWrapper__factory,
  PredicateRouterWrapper__factory,
  StaticAggregationHook__factory,
  StaticAggregationHookFactory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { OnchainHookType } from '../hook/types.js';
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

    const overrides = this.multiProvider.getTransactionOverrides(chain);

    // Deploy the appropriate wrapper based on token type
    // Token address is fetched from warpRoute.token() in constructor
    const wrapper = isCrossCollateral
      ? await new PredicateCrossCollateralRouterWrapper__factory(signer).deploy(
          warpRouteAddress,
          config.predicateRegistry,
          config.policyId,
          overrides,
        )
      : await new PredicateRouterWrapper__factory(signer).deploy(
          warpRouteAddress,
          config.predicateRegistry,
          config.policyId,
          overrides,
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
      wrapper.transferOwnership(routeOwner, overrides),
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
   * array.
   *
   * IMPORTANT — irreversible side effects: deployPredicateWrapper submits a real on-chain
   * transaction before this method returns. If the caller discards the returned setHookTx
   * (dry-run, cancellation, error), the PredicateRouterWrapper is orphaned — deployed but
   * unreferenced by any warp route. The aggregation hook is safe because
   * StaticAggregationHookFactory uses CREATE2 (idempotent). Eliminating the wrapper orphan
   * risk requires a CREATE2 factory for PredicateRouterWrapper (future contract work).
   *
   * This differs from EvmHookModule/EvmIsmModule: those modules own the full configuration
   * lifecycle (deploy + configure in one atomic step). Here, deployment is eager but the
   * final wiring (setHook) is deferred to EvmWarpModule.update(), which may choose not to
   * submit it.
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
    const rawExistingHook = existingHookOverride ?? (await warpRoute.hook());

    // If the existing hook is already an aggregation containing a predicate wrapper,
    // unwrap it to the base (non-predicate) hook before re-aggregating. Without this,
    // updating a predicate config would stack wrappers:
    //   newAggregation([newWrapper, oldAggregation([oldWrapper, IGP])])
    // instead of the correct:
    //   newAggregation([newWrapper, IGP])
    const existingHook = await this.stripPredicateFromHook(
      chain,
      rawExistingHook,
    );

    // WARNING: deployPredicateWrapper submits a real on-chain transaction here.
    // If the caller discards the returned setHookTx, this wrapper will be orphaned.
    this.logger.warn(
      { chain, warpRoute: warpRouteAddress },
      'Deploying PredicateRouterWrapper — this on-chain deployment is irreversible. ' +
        'Submit the returned setHookTx to complete wiring; discarding it will leave the wrapper orphaned.',
    );
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

  /**
   * If hookAddress is a StaticAggregationHook that contains a predicate wrapper,
   * returns the single non-predicate sub-hook so the caller can aggregate against
   * the base hook directly (avoiding stacked wrappers on config updates).
   *
   * Falls back to hookAddress unchanged when:
   * - The address is zero / not an aggregation hook
   * - No predicate wrapper is found among sub-hooks
   * - Multiple non-predicate sub-hooks remain (cannot safely re-aggregate here)
   */
  private async stripPredicateFromHook(
    chain: ChainName,
    hookAddress: Address,
  ): Promise<Address> {
    if (!hookAddress || hookAddress === constants.AddressZero) {
      return hookAddress;
    }

    const provider = this.multiProvider.getProvider(chain);

    try {
      const subHooks = await StaticAggregationHook__factory.connect(
        hookAddress,
        provider,
      ).hooks('0x');

      if (!subHooks || subHooks.length === 0) return hookAddress;

      const nonPredicateHooks: Address[] = [];
      for (const sub of subHooks) {
        try {
          const hookType = await PredicateRouterWrapper__factory.connect(
            sub,
            provider,
          ).hookType();
          if (hookType === OnchainHookType.PREDICATE_ROUTER_WRAPPER) {
            this.logger.debug(
              { chain, predicateWrapper: sub },
              'Stripping existing predicate wrapper from aggregation to avoid stacking',
            );
          } else {
            nonPredicateHooks.push(sub);
          }
        } catch {
          // hookType() failed — not a recognisable hook; keep it
          nonPredicateHooks.push(sub);
        }
      }

      if (nonPredicateHooks.length === subHooks.length) {
        // No predicate wrapper found — use hook as-is
        return hookAddress;
      }

      if (nonPredicateHooks.length === 1) {
        // Happy path: exactly one base hook remains
        return nonPredicateHooks[0];
      }

      // Multiple non-predicate sub-hooks remain after removing the predicate wrapper.
      // Re-aggregate them via CREATE2 (idempotent) so the caller produces:
      //   outerAgg([newWrapper, innerAgg([hookA, hookB])])
      // instead of the stacking anti-pattern:
      //   newAgg([newWrapper, oldAgg([oldWrapper, hookA, hookB])])
      this.logger.debug(
        { chain, nonPredicateHooks },
        'Multiple non-predicate sub-hooks found — re-aggregating without predicate wrapper',
      );
      const signer = this.multiProvider.getSigner(chain);
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const factory = this.staticAggregationHookFactory.connect(signer);
      const threshold = nonPredicateHooks.length;
      const innerAggAddress = await factory['getAddress(address[],uint8)'](
        nonPredicateHooks,
        threshold,
      );
      const code = await this.multiProvider
        .getProvider(chain)
        .getCode(innerAggAddress);
      if (code === '0x') {
        const tx = await factory['deploy(address[],uint8)'](
          nonPredicateHooks,
          threshold,
          overrides,
        );
        await this.multiProvider.handleTx(chain, tx);
        this.logger.info(
          { chain, innerAgg: innerAggAddress, hooks: nonPredicateHooks },
          'Inner aggregation hook deployed for predicate-stripped sub-hooks',
        );
      } else {
        this.logger.debug(
          { chain, innerAgg: innerAggAddress },
          'Recovered existing inner aggregation hook',
        );
      }
      return innerAggAddress;
    } catch {
      // Not a StaticAggregationHook or call failed — use hook as-is
      return hookAddress;
    }
  }
}
