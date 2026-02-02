import type { Logger } from 'pino';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
  type EthJsonRpcBlockParameterTag,
  HyperlaneCore,
  type MultiProvider,
  TOKEN_COLLATERALIZED_STANDARDS,
  type WarpCore,
} from '@hyperlane-xyz/sdk';

import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type {
  IInventoryRebalancer,
  InventoryExecutionResult,
  InventoryRoute,
} from '../interfaces/IInventoryRebalancer.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type {
  PartialInventoryIntent,
  RebalanceIntent,
} from '../tracking/types.js';
import {
  MIN_VIABLE_COST_MULTIPLIER,
  calculateTransferCosts,
} from '../utils/gasEstimation.js';
import { isNativeTokenStandard } from '../utils/tokenUtils.js';

/**
 * Buffer percentage to add when bridging inventory.
 * Bridges (amount * (100 + BRIDGE_BUFFER_PERCENT)) / 100 to account for slippage.
 */
const BRIDGE_BUFFER_PERCENT = 5n;

/**
 * Multiplier applied to LiFi's quoted gas costs.
 * LiFi consistently underestimates gas, and gas prices can spike significantly
 * between quote and execution. Using 100x provides headroom for volatility.
 */
const GAS_COST_MULTIPLIER = 100n;

/**
 * Maximum percentage of inventory that gas costs can consume for a bridge to be viable.
 * If gas exceeds this threshold, the bridge is not economically worthwhile.
 */
const MAX_GAS_PERCENT_THRESHOLD = 10n;

/**
 * Configuration for the InventoryRebalancer.
 */
export interface InventoryRebalancerConfig {
  /** EOA address of the inventory signer */
  inventorySigner: string;
  /** Optional MultiProvider with inventory signer for signing transactions */
  inventoryMultiProvider?: MultiProvider;
  /** Chains configured for inventory-based rebalancing (for validation) */
  inventoryChains: ChainName[];
}

/**
 * Executes inventory-based rebalances for chains that don't support MovableCollateralRouter.
 *
 * IMPORTANT: transferRemote ADDS collateral to the ORIGIN chain (where it's called FROM).
 * So for a strategy route "base (surplus) → arbitrum (deficit)", we must:
 * 1. Ensure inventory is available on the DESTINATION (deficit) chain - arbitrum
 * 2. Call transferRemote FROM arbitrum TO base
 * 3. This ADDS collateral to arbitrum (filling deficit) and releases from base (has surplus)
 *
 * The flow is:
 * 1. Check if inventory is available on the destination (deficit) chain
 * 2. If available, execute transferRemote from destination to origin (swapped direction)
 * 3. If not available, bridge inventory to destination via LiFi, then execute transferRemote
 *
 * Actions created:
 * - `inventory_movement`: LiFi bridge to move inventory to deficit chain
 * - `inventory_deposit`: transferRemote to deposit collateral on deficit chain
 */
export class InventoryRebalancer implements IInventoryRebalancer {
  private readonly logger: Logger;
  private readonly config: InventoryRebalancerConfig;
  private readonly inventoryMonitor: IInventoryMonitor;
  private readonly actionTracker: IActionTracker;
  // Bridge will be used for inventory_movement actions in future implementation
  private readonly _bridge: IExternalBridge;
  private readonly warpCore: WarpCore;
  private readonly multiProvider: MultiProvider;

  /**
   * Tracks inventory consumed during the current execution cycle.
   * Cleared at the start of each execute() call.
   * Used to prevent over-execution when multiple routes withdraw from the same chain.
   */
  private consumedInventory: Map<ChainName, bigint> = new Map();

  constructor(
    config: InventoryRebalancerConfig,
    inventoryMonitor: IInventoryMonitor,
    actionTracker: IActionTracker,
    bridge: IExternalBridge,
    warpCore: WarpCore,
    multiProvider: MultiProvider,
    logger: Logger,
  ) {
    this.config = config;
    this.inventoryMonitor = inventoryMonitor;
    this.actionTracker = actionTracker;
    this._bridge = bridge;
    this.warpCore = warpCore;
    this.multiProvider = multiProvider;
    this.logger = logger;

    // Validate that all tokens are collateral-backed
    // Synthetic tokens cannot be used with inventory rebalancing because:
    // - transferRemote on synthetics mints new tokens (doesn't transfer collateral)
    // - There's no collateral to deposit/withdraw
    this.validateCollateralBackedTokens();

    this.logger.info(
      { inventorySigner: config.inventorySigner },
      'InventoryRebalancer initialized',
    );
  }

  private getNativeTokenAddress(): string {
    const addr = this._bridge.getNativeTokenAddress?.();
    if (!addr) {
      throw new Error(
        `Bridge '${this._bridge.bridgeId}' does not support getNativeTokenAddress()`,
      );
    }
    return addr;
  }

  /**
   * Validate that tokens on inventory chains are collateral-backed.
   * Only checks tokens for chains configured with inventory-based rebalancing.
   * Throws an error if any synthetic tokens are found on inventory chains.
   */
  private validateCollateralBackedTokens(): void {
    const inventoryChainSet = new Set(this.config.inventoryChains);

    for (const token of this.warpCore.tokens) {
      // Only validate tokens for chains configured for inventory rebalancing
      if (!inventoryChainSet.has(token.chainName)) {
        continue;
      }

      if (!TOKEN_COLLATERALIZED_STANDARDS.includes(token.standard)) {
        throw new Error(
          `InventoryRebalancer cannot be used with synthetic token on chain "${token.chainName}". ` +
            `Token standard "${token.standard}" is not collateral-backed. ` +
            `Only collateral-backed standards are supported: ${TOKEN_COLLATERALIZED_STANDARDS.join(', ')}`,
        );
      }
    }
  }

  /**
   * Get the external bridge (for future inventory_movement implementation).
   * TODO: Remove this getter once inventory_movement is implemented.
   */
  protected get bridge(): IExternalBridge {
    return this._bridge;
  }

  /**
   * Get the token for a specific chain from WarpCore.
   */
  private getTokenForChain(chainName: ChainName) {
    return this.warpCore.tokens.find((t) => t.chainName === chainName);
  }

  /**
   * Get the effective available inventory for a chain, accounting for
   * inventory already consumed during this execution cycle.
   *
   * This prevents over-execution when multiple routes withdraw from the same chain.
   *
   * @param chain - The chain to check inventory for
   * @returns Effective available inventory (cached - consumed)
   */
  private async getEffectiveAvailableInventory(
    chain: ChainName,
  ): Promise<bigint> {
    const cached = await this.inventoryMonitor.getAvailableInventory(chain);
    const consumed = this.consumedInventory.get(chain) ?? 0n;
    const effective = cached > consumed ? cached - consumed : 0n;

    if (consumed > 0n) {
      this.logger.debug(
        {
          chain,
          cachedInventory: cached.toString(),
          consumedThisCycle: consumed.toString(),
          effectiveInventory: effective.toString(),
        },
        'Calculated effective inventory after prior executions',
      );
    }

    return effective;
  }

  /**
   * Execute inventory-based rebalances for the given routes.
   *
   * Single-intent architecture:
   * 1. Check for existing in_progress intent
   * 2. If exists, continue existing intent (ignores new routes)
   * 3. If not, take only the FIRST route and create a single intent
   */
  async execute(routes: InventoryRoute[]): Promise<InventoryExecutionResult[]> {
    // Clear consumed inventory tracking at the start of each execution cycle
    this.consumedInventory.clear();

    // 1. Check for existing in_progress intent
    const activeIntent = await this.getActiveInventoryIntent();

    if (activeIntent) {
      // Continue existing intent, ignore new routes
      this.logger.info(
        {
          intentId: activeIntent.intent.id,
          remaining: activeIntent.remaining.toString(),
          newRoutesIgnored: routes.length,
        },
        'Continuing existing intent, ignoring new routes',
      );
      return this.continueIntent(activeIntent);
    }

    // 2. No existing intent - take first route only
    if (routes.length === 0) return [];

    const route = routes[0];
    if (routes.length > 1) {
      this.logger.info(
        {
          selectedRoute: `${route.origin} → ${route.destination}`,
          discardedCount: routes.length - 1,
        },
        'Taking first route only, discarding others',
      );
    }

    // 3. Create intent and execute
    const intent = await this.actionTracker.createRebalanceIntent({
      origin: this.multiProvider.getDomainId(route.origin),
      destination: this.multiProvider.getDomainId(route.destination),
      amount: route.amount,
      executionMethod: 'inventory',
    });

    this.logger.debug(
      {
        intentId: intent.id,
        origin: route.origin,
        destination: route.destination,
        amount: route.amount.toString(),
      },
      'Created new inventory rebalance intent',
    );

    try {
      const result = await this.executeRoute(route, intent);

      // Update consumed inventory on success
      if (result.success && result.amountSent) {
        const current = this.consumedInventory.get(route.destination) ?? 0n;
        this.consumedInventory.set(
          route.destination,
          current + result.amountSent,
        );
      }

      return [result];
    } catch (error) {
      this.logger.error(
        {
          route,
          intentId: intent.id,
          error: (error as Error).message,
        },
        'Failed to execute inventory route',
      );

      return [
        {
          route,
          intent,
          success: false,
          error: (error as Error).message,
        },
      ];
    }
  }

  /**
   * Get the single active inventory intent (if any).
   * Returns null if no in_progress inventory intent exists.
   */
  private async getActiveInventoryIntent(): Promise<PartialInventoryIntent | null> {
    const partialIntents =
      await this.actionTracker.getPartiallyFulfilledInventoryIntents();
    return partialIntents.length > 0 ? partialIntents[0] : null;
  }

  /**
   * Continue execution of an existing partial intent.
   * Uses the pre-computed remaining amount from PartialInventoryIntent.
   */
  private async continueIntent(
    partial: PartialInventoryIntent,
  ): Promise<InventoryExecutionResult[]> {
    const { intent, remaining } = partial;

    const route: InventoryRoute = {
      origin: this.multiProvider.getChainName(intent.origin),
      destination: this.multiProvider.getChainName(intent.destination),
      amount: remaining,
    };

    this.logger.info(
      {
        intentId: intent.id,
        origin: route.origin,
        destination: route.destination,
        remaining: remaining.toString(),
        completed: partial.completedAmount.toString(),
        total: intent.amount.toString(),
      },
      'Continuing partial inventory intent',
    );

    // Warn if intent never started - indicates previous execution attempt failed
    // without creating any actions (e.g., all bridges failed viability check)
    if (intent.status === 'not_started') {
      this.logger.warn(
        {
          intentId: intent.id,
          origin: route.origin,
          destination: route.destination,
        },
        'Retrying intent that never started - previous execution attempt failed without creating any actions',
      );
    }

    try {
      const result = await this.executeRoute(route, intent);

      // Update consumed inventory on success
      if (result.success && result.amountSent) {
        const current = this.consumedInventory.get(route.destination) ?? 0n;
        this.consumedInventory.set(
          route.destination,
          current + result.amountSent,
        );
      }

      return [result];
    } catch (error) {
      this.logger.error(
        {
          route,
          intentId: intent.id,
          error: (error as Error).message,
        },
        'Failed to continue partial inventory intent',
      );

      return [
        {
          route,
          intent,
          success: false,
          error: (error as Error).message,
        },
      ];
    }
  }

  /**
   * Execute a single inventory route.
   *
   * Strategy provides: origin (surplus) → destination (deficit)
   * "Move collateral FROM origin TO destination"
   *
   * IMPORTANT: transferRemote ADDS collateral to the chain it's called FROM.
   * So to fill the deficit on destination, we must:
   * - Call transferRemote FROM destination TO origin (SWAPPED direction)
   * - This ADDS to destination (deficit filled!) and RELEASES from origin (has surplus)
   *
   * Execution flow:
   * 1. Check inventory on DESTINATION (deficit chain) - need funds there to call transferRemote
   * 2. If low, LiFi bridge TO destination
   * 3. Call transferRemote FROM destination TO origin (swapped)
   */
  private async executeRoute(
    route: InventoryRoute,
    intent: RebalanceIntent,
  ): Promise<InventoryExecutionResult> {
    const { origin, destination, amount } = route;

    this.logger.info(
      {
        strategyRoute: `${origin} (surplus) → ${destination} (deficit)`,
        executionRoute: `transferRemote FROM ${destination} TO ${origin}`,
        amount: amount.toString(),
        intentId: intent.id,
      },
      'Executing inventory route',
    );

    // Check available inventory on the DESTINATION (deficit) chain
    // We need inventory here because transferRemote is called FROM this chain
    const availableInventory =
      await this.getEffectiveAvailableInventory(destination);

    this.logger.info(
      {
        checkingChain: destination,
        availableInventory: availableInventory.toString(),
        availableInventoryEth: (Number(availableInventory) / 1e18).toFixed(6),
        requiredAmount: amount.toString(),
        requiredAmountEth: (Number(amount) / 1e18).toFixed(6),
      },
      'Checking effective inventory on destination (deficit) chain',
    );

    // Calculate transfer costs including max transferable and min viable amounts
    // transferRemote is called FROM destination TO origin (swapped direction)
    const costs = await calculateTransferCosts(
      destination, // FROM chain (where transferRemote is called)
      origin, // TO chain (where Hyperlane message goes)
      availableInventory,
      amount,
      this.multiProvider,
      this.warpCore.multiProvider,
      this.getTokenForChain.bind(this),
      this.config.inventorySigner,
      isNativeTokenStandard,
      this.logger,
    );
    const { maxTransferable, minViableTransfer } = costs;

    // Calculate total inventory across all chains
    // Note: consumedInventory tracking is handled separately within this cycle
    const totalInventory = await this.inventoryMonitor.getTotalInventory([]);

    this.logger.info(
      {
        fromChain: destination,
        toChain: origin,
        availableInventoryEth: (Number(availableInventory) / 1e18).toFixed(6),
        requestedAmountEth: (Number(amount) / 1e18).toFixed(6),
        maxTransferableEth: (Number(maxTransferable) / 1e18).toFixed(6),
        minViableTransferEth: (Number(minViableTransfer) / 1e18).toFixed(6),
        totalInventoryEth: (Number(totalInventory) / 1e18).toFixed(6),
        canFullyFulfill: maxTransferable >= amount,
        canPartialFulfill: maxTransferable >= minViableTransfer,
      },
      'Calculated max transferable amount with cost-based threshold',
    );

    // Early exit: If remaining amount is below minViableTransfer, complete the intent
    // This prevents infinite loops when the remaining amount is too small to economically bridge
    if (amount < minViableTransfer) {
      this.logger.info(
        {
          intentId: intent.id,
          amount: amount.toString(),
          minViableTransfer: minViableTransfer.toString(),
        },
        'Remaining amount below minViableTransfer, completing intent with acceptable loss',
      );

      await this.actionTracker.completeRebalanceIntent(intent.id);

      return {
        route,
        intent,
        success: true,
        reason: 'completed_with_acceptable_loss',
      };
    }

    // Swap the route for executeTransferRemote: destination → origin
    // This ensures transferRemote is called FROM destination, ADDING collateral there
    const swappedRoute: InventoryRoute = {
      origin: destination, // transferRemote called FROM here
      destination: origin, // Hyperlane message goes TO here
      amount,
    };

    if (maxTransferable >= amount) {
      // Sufficient inventory on destination - execute transferRemote directly
      const result = await this.executeTransferRemote(
        swappedRoute,
        intent,
        costs.gasQuote!,
      );
      // Return original strategy route in result (not the swapped execution route)
      return { ...result, route };
    } else if (maxTransferable > 0n && maxTransferable >= minViableTransfer) {
      // Partial transfer: Transfer available inventory when economically viable
      const partialSwappedRoute = { ...swappedRoute, amount: maxTransferable };
      const result = await this.executeTransferRemote(
        partialSwappedRoute,
        intent,
        costs.gasQuote!,
      );

      this.logger.info(
        {
          intentId: intent.id,
          partialAmount: maxTransferable.toString(),
          requestedAmount: amount.toString(),
          remainingAmount: (amount - maxTransferable).toString(),
        },
        'Executed partial inventory deposit, remaining will be handled in future cycles',
      );

      // Return original strategy route in result (not the swapped execution route)
      return { ...result, route };
    } else {
      // Inventory below cost-based threshold - trigger ExternalBridge movement TO destination chain
      this.logger.info(
        {
          targetChain: destination,
          maxTransferable: maxTransferable.toString(),
          minViableTransfer: minViableTransfer.toString(),
          costMultiplier: MIN_VIABLE_COST_MULTIPLIER.toString(),
          intentId: intent.id,
        },
        'Inventory below cost-based threshold on destination, triggering LiFi movement',
      );

      // Get all available source chains with raw inventory
      const allSources = await this.selectAllSourceChains(destination);

      if (allSources.length === 0) {
        this.logger.warn(
          {
            origin,
            destination,
            amount: amount.toString(),
            intentId: intent.id,
          },
          'No inventory available on any monitored chain',
        );

        return {
          route,
          intent,
          success: false,
          error: 'No inventory available on any monitored chain',
        };
      }

      // NEW: Calculate max viable amount for each source chain
      // This uses the quote API to determine gas costs upfront
      const viableSources: Array<{ chain: ChainName; maxViable: bigint }> = [];

      for (const source of allSources) {
        const maxViable = await this.calculateMaxViableBridgeAmount(
          source.chain,
          destination,
          source.availableAmount,
        );

        if (maxViable > 0n) {
          viableSources.push({ chain: source.chain, maxViable });
        }
      }

      // Sort by max viable descending (bridge from largest sources first)
      viableSources.sort((a, b) => (a.maxViable > b.maxViable ? -1 : 1));

      if (viableSources.length === 0) {
        this.logger.warn(
          {
            targetChain: destination,
            sourcesChecked: allSources.length,
            intentId: intent.id,
          },
          'No viable bridge sources - all chains have insufficient inventory or high gas costs',
        );

        return {
          route,
          intent,
          success: false,
          error: 'No viable bridge sources available',
        };
      }

      // Create bridge plans using VIABLE amounts (gas already accounted for)
      const targetWithBuffer =
        ((amount + costs.totalCost) * (100n + BRIDGE_BUFFER_PERCENT)) / 100n;
      const bridgePlans: Array<{ chain: ChainName; amount: bigint }> = [];
      let totalPlanned = 0n;

      for (const source of viableSources) {
        if (totalPlanned >= targetWithBuffer) break;

        const remaining = targetWithBuffer - totalPlanned;
        const amountFromSource =
          source.maxViable >= remaining ? remaining : source.maxViable; // Already gas-adjusted!

        bridgePlans.push({ chain: source.chain, amount: amountFromSource });
        totalPlanned += amountFromSource;
      }

      this.logger.info(
        {
          targetChain: destination,
          viableSources: viableSources.map((s) => ({
            chain: s.chain,
            maxViable: s.maxViable.toString(),
            maxViableEth: (Number(s.maxViable) / 1e18).toFixed(6),
          })),
          bridgePlans: bridgePlans.map((p) => ({
            chain: p.chain,
            amount: p.amount.toString(),
            amountEth: (Number(p.amount) / 1e18).toFixed(6),
          })),
          totalPlanned: totalPlanned.toString(),
          targetWithBuffer: targetWithBuffer.toString(),
          intentId: intent.id,
        },
        'Created bridge plans using gas-adjusted viable amounts',
      );

      // Execute all bridges in parallel
      const bridgeResults = await Promise.allSettled(
        bridgePlans.map((plan) =>
          this.executeInventoryMovement(
            plan.chain,
            destination,
            plan.amount,
            intent,
          ),
        ),
      );

      // Process results
      let successCount = 0;
      let totalBridged = 0n;
      const failedErrors: string[] = [];

      for (let i = 0; i < bridgeResults.length; i++) {
        const result = bridgeResults[i];
        const plan = bridgePlans[i];

        if (result.status === 'fulfilled' && result.value.success) {
          successCount++;
          totalBridged += plan.amount;
          this.logger.info(
            {
              sourceChain: plan.chain,
              amount: plan.amount.toString(),
              txHash: result.value.txHash,
            },
            'Inventory movement succeeded',
          );
        } else {
          const error =
            result.status === 'rejected'
              ? result.reason?.message
              : result.value.error;
          if (error) {
            failedErrors.push(`${plan.chain}: ${error}`);
          }
          this.logger.warn(
            { sourceChain: plan.chain, amount: plan.amount.toString(), error },
            'Inventory movement failed',
          );
        }
      }

      if (successCount === 0) {
        // Include specific error messages to help diagnose failures (e.g., insufficient funds)
        const errorDetails =
          failedErrors.length > 0 ? ` (${failedErrors.join('; ')})` : '';
        return {
          route,
          intent,
          success: false,
          error: `All inventory movements failed${errorDetails}`,
        };
      }

      this.logger.info(
        {
          targetChain: destination,
          successCount,
          totalBridged: totalBridged.toString(),
          targetAmount: amount.toString(),
          intentId: intent.id,
        },
        'Parallel inventory movements completed, transferRemote will execute after bridges complete',
      );

      return { route, intent, success: true };
    }
  }

  /**
   * Execute a transferRemote to deposit collateral.
   *
   * IMPORTANT: The route passed here has SWAPPED direction from the strategy route.
   * - route.origin = the deficit chain (where transferRemote is called FROM)
   * - route.destination = the surplus chain (where Hyperlane message goes TO)
   *
   * transferRemote mechanics:
   * - Calls _transferFromSender() which ADDS collateral to route.origin
   * - Sends Hyperlane message to route.destination to RELEASE collateral
   *
   * @param route - The transfer route (swapped direction)
   * @param intent - The rebalance intent being executed
   * @param gasQuote - Pre-calculated gas quote from calculateTransferCosts
   */
  private async executeTransferRemote(
    route: InventoryRoute,
    intent: RebalanceIntent,
    gasQuote: { igpQuote: { amount: bigint } },
  ): Promise<InventoryExecutionResult> {
    const { origin, destination, amount } = route;

    const originToken = this.getTokenForChain(origin);
    if (!originToken) {
      throw new Error(`No token found for origin chain: ${origin}`);
    }

    const destinationDomain = this.multiProvider.getDomainId(destination);

    // Get the hyperlane adapter for the token
    const adapter = originToken.getHypAdapter(this.warpCore.multiProvider);

    this.logger.debug(
      {
        origin,
        destination,
        amount: amount.toString(),
        gasQuote: {
          igpQuote: gasQuote.igpQuote.amount.toString(),
        },
      },
      'Using pre-calculated gas quote for transferRemote',
    );

    // Populate the transferRemote transaction
    const populatedTx = await adapter.populateTransferRemoteTx({
      destination: destinationDomain,
      recipient: this.config.inventorySigner,
      weiAmountOrId: amount,
      interchainGas: gasQuote,
    });

    // Send the transaction using inventory MultiProvider if available
    this.logger.info(
      {
        origin,
        destination,
        amount: amount.toString(),
        intentId: intent.id,
      },
      'Sending transferRemote transaction',
    );

    // Use inventoryMultiProvider if available, otherwise fall back to multiProvider
    const signingProvider =
      this.config.inventoryMultiProvider ?? this.multiProvider;

    // Get reorgPeriod for confirmation waiting
    const reorgPeriod =
      this.multiProvider.getChainMetadata(origin).blocks?.reorgPeriod ?? 32;

    // Wait for reorgPeriod confirmations via SDK to ensure Monitor sees balance changes
    const receipt = await signingProvider.sendTransaction(
      origin,
      populatedTx as AnnotatedEV5Transaction,
      {
        waitConfirmations: reorgPeriod as number | EthJsonRpcBlockParameterTag,
      },
    );

    // Extract messageId from the transaction receipt logs
    const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);
    const messageId = dispatchedMessages[0]?.id;

    if (!messageId) {
      this.logger.warn(
        {
          origin,
          destination,
          txHash: receipt.transactionHash,
          intentId: intent.id,
        },
        'TransferRemote transaction sent but no messageId found in logs',
      );
    }

    this.logger.info(
      {
        origin,
        destination,
        txHash: receipt.transactionHash,
        messageId,
        intentId: intent.id,
      },
      'TransferRemote transaction confirmed',
    );

    // Create the inventory_deposit action with messageId for tracking
    await this.actionTracker.createRebalanceAction({
      intentId: intent.id,
      origin: this.multiProvider.getDomainId(origin),
      destination: destinationDomain,
      amount,
      type: 'inventory_deposit',
      txHash: receipt.transactionHash,
      messageId,
    });

    return {
      route,
      intent,
      success: true,
      amountSent: amount,
    };
  }

  /**
   * Check if a route can be executed with current inventory.
   * Returns the amount that can be fulfilled immediately.
   *
   * Note: Checks inventory on DESTINATION chain since that's where
   * transferRemote is called FROM (swapped direction).
   */
  async getAvailableAmount(route: InventoryRoute): Promise<bigint> {
    // Check inventory on destination (deficit chain) since that's where
    // we call transferRemote FROM
    const availableInventory =
      await this.inventoryMonitor.getAvailableInventory(route.destination);

    // Return the minimum of available inventory and requested amount
    return availableInventory < route.amount
      ? availableInventory
      : route.amount;
  }

  /**
   * Select all source chains with available inventory for bridging.
   * Returns sources sorted by available amount (highest first).
   */
  private async selectAllSourceChains(
    targetChain: ChainName,
  ): Promise<Array<{ chain: ChainName; availableAmount: bigint }>> {
    const balances = await this.inventoryMonitor.getBalances();
    const sources: Array<{ chain: ChainName; availableAmount: bigint }> = [];

    for (const [chainName, balance] of balances) {
      if (chainName === targetChain) continue;

      const consumed = this.consumedInventory.get(chainName) ?? 0n;
      const effectiveAvailable =
        balance.available > consumed ? balance.available - consumed : 0n;

      if (effectiveAvailable > 0n) {
        sources.push({ chain: chainName, availableAmount: effectiveAvailable });
      }
    }

    // Sort by available amount descending (bridge from largest sources first)
    return sources.sort((a, b) =>
      a.availableAmount > b.availableAmount ? -1 : 1,
    );
  }

  /**
   * Calculate the maximum amount that can be bridged from a source chain.
   * Uses LiFi quote to determine gas costs, applies 20x multiplier buffer.
   * Returns 0 if gas exceeds 10% of inventory (not economically viable).
   *
   * This is the key method for the gas-aware planning approach:
   * - Gets a quote for the full raw inventory to determine actual gas costs
   * - Applies conservative 20x buffer (LiFi underestimates by ~14x historically)
   * - Returns 0 if gas > 10% of inventory (not worth bridging)
   * - Returns inventory - estimatedGas if viable
   *
   * @param sourceChain - Chain to bridge from
   * @param targetChain - Chain to bridge to
   * @param rawInventory - Raw available inventory on source chain
   * @returns Maximum viable bridge amount (0 if not viable)
   */
  private async calculateMaxViableBridgeAmount(
    sourceChain: ChainName,
    targetChain: ChainName,
    rawInventory: bigint,
  ): Promise<bigint> {
    const sourceToken = this.getTokenForChain(sourceChain);
    const targetToken = this.getTokenForChain(targetChain);

    if (!sourceToken || !targetToken) return 0n;

    // Only applies to native tokens (need gas from same balance)
    if (!isNativeTokenStandard(sourceToken.standard)) {
      return rawInventory; // ERC20s don't compete with gas
    }

    // Convert HypNative token addresses to LiFi's native ETH representation
    const fromTokenAddress = this.getNativeTokenAddress();
    const toTokenAddress = isNativeTokenStandard(targetToken.standard)
      ? this.getNativeTokenAddress()
      : targetToken.addressOrDenom;

    const sourceChainId = Number(this.multiProvider.getChainId(sourceChain));
    const targetChainId = Number(this.multiProvider.getChainId(targetChain));

    try {
      // Get quote to determine gas costs
      const quote = await this._bridge.quote({
        fromChain: sourceChainId,
        toChain: targetChainId,
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        fromAmount: rawInventory,
        fromAddress: this.config.inventorySigner,
        toAddress: this.config.inventorySigner,
      });

      // Apply 20x multiplier on quoted gas (LiFi underestimates by ~14x)
      const estimatedGas = quote.gasCosts * GAS_COST_MULTIPLIER;

      // Viability check: gas should not exceed 10% of inventory
      const maxGasThreshold = rawInventory / MAX_GAS_PERCENT_THRESHOLD;
      if (estimatedGas > maxGasThreshold) {
        this.logger.info(
          {
            sourceChain,
            targetChain,
            rawInventory: rawInventory.toString(),
            rawInventoryEth: (Number(rawInventory) / 1e18).toFixed(6),
            quotedGas: quote.gasCosts.toString(),
            estimatedGas: estimatedGas.toString(),
            estimatedGasEth: (Number(estimatedGas) / 1e18).toFixed(6),
            maxGasThreshold: maxGasThreshold.toString(),
            gasPercent: `${(Number(estimatedGas) * 100) / Number(rawInventory)}%`,
          },
          'Bridge not viable - gas cost exceeds 10% of inventory',
        );
        return 0n;
      }

      // Max viable = inventory minus estimated gas
      const maxViable = rawInventory - estimatedGas;

      this.logger.info(
        {
          sourceChain,
          targetChain,
          rawInventory: rawInventory.toString(),
          rawInventoryEth: (Number(rawInventory) / 1e18).toFixed(6),
          quotedGas: quote.gasCosts.toString(),
          estimatedGas: estimatedGas.toString(),
          estimatedGasEth: (Number(estimatedGas) / 1e18).toFixed(6),
          maxViable: maxViable.toString(),
          maxViableEth: (Number(maxViable) / 1e18).toFixed(6),
        },
        'Calculated max viable bridge amount',
      );

      return maxViable;
    } catch (error) {
      this.logger.warn(
        {
          sourceChain,
          targetChain,
          error: (error as Error).message,
        },
        'Failed to calculate max viable bridge amount, skipping chain',
      );
      return 0n;
    }
  }

  /**
   * Execute inventory movement from source chain to target chain via LiFi bridge.
   *
   * IMPORTANT: The amount parameter is now the MAX VIABLE amount (gas already subtracted
   * by calculateMaxViableBridgeAmount). This method trusts that the amount is pre-validated.
   *
   * @param sourceChain - Chain to move inventory from
   * @param targetChain - Chain to move inventory to (origin chain for rebalancing)
   * @param amount - Pre-validated amount to bridge (gas already accounted for)
   * @param intent - Rebalance intent for tracking
   * @returns Result with success status and optional txHash/error
   */
  private async executeInventoryMovement(
    sourceChain: ChainName,
    targetChain: ChainName,
    amount: bigint,
    intent: RebalanceIntent,
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const sourceToken = this.getTokenForChain(sourceChain);
    if (!sourceToken) {
      return {
        success: false,
        error: `No token found for source chain: ${sourceChain}`,
      };
    }

    const targetToken = this.getTokenForChain(targetChain);
    if (!targetToken) {
      return {
        success: false,
        error: `No token found for target chain: ${targetChain}`,
      };
    }

    // Get chain IDs for the external bridge (not domain IDs)
    // Convert to number since getChainId can return string | number
    const sourceChainId = Number(this.multiProvider.getChainId(sourceChain));
    const targetChainId = Number(this.multiProvider.getChainId(targetChain));

    // Convert HypNative token addresses to LiFi's native ETH representation
    // For HypNative tokens, addressOrDenom is the warp route contract, not the native token
    const fromTokenAddress = isNativeTokenStandard(sourceToken.standard)
      ? this.getNativeTokenAddress()
      : sourceToken.addressOrDenom;

    const toTokenAddress = isNativeTokenStandard(targetToken.standard)
      ? this.getNativeTokenAddress()
      : targetToken.addressOrDenom;

    this.logger.debug(
      {
        sourceTokenStandard: sourceToken.standard,
        targetTokenStandard: targetToken.standard,
        fromTokenAddress,
        toTokenAddress,
      },
      'Resolved token addresses for LiFi bridge',
    );

    // Calculate minViableTransfer for the target chain
    // If bridging less than this, the received amount won't be enough to execute transferRemote
    // So we over-bridge to ensure we can complete the intent in the next cycle
    const costs = await calculateTransferCosts(
      targetChain, // FROM chain for transferRemote (the target of this bridge)
      sourceChain, // TO chain for transferRemote (Hyperlane message destination)
      amount, // availableInventory (not used for minViableTransfer calculation)
      amount, // requestedAmount
      this.multiProvider,
      this.warpCore.multiProvider,
      this.getTokenForChain.bind(this),
      this.config.inventorySigner,
      isNativeTokenStandard,
      this.logger,
    );
    const { minViableTransfer } = costs;

    // If the requested amount is below minViableTransfer, adjust it up
    // This ensures we bridge enough to actually complete the final transferRemote
    const effectiveAmount =
      amount < minViableTransfer ? minViableTransfer : amount;

    if (effectiveAmount !== amount) {
      this.logger.info(
        {
          originalAmount: amount.toString(),
          effectiveAmount: effectiveAmount.toString(),
          minViableTransfer: minViableTransfer.toString(),
          originalAmountEth: (Number(amount) / 1e18).toFixed(6),
          effectiveAmountEth: (Number(effectiveAmount) / 1e18).toFixed(6),
          minViableTransferEth: (Number(minViableTransfer) / 1e18).toFixed(6),
          adjustedUp: true,
          intentId: intent.id,
        },
        'Over-bridging to minViableTransfer to ensure final transferRemote can complete',
      );
    }

    try {
      // The amount parameter is pre-validated by calculateMaxViableBridgeAmount
      // Use fromAmount quote directly since we know we can afford this amount
      const quote = await this._bridge.quote({
        fromChain: sourceChainId,
        toChain: targetChainId,
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        fromAmount: effectiveAmount, // Use the pre-validated amount directly
        fromAddress: this.config.inventorySigner,
        toAddress: this.config.inventorySigner,
      });

      const inputRequired = quote.fromAmount;

      this.logger.info(
        {
          sourceChain,
          targetChain,
          sourceChainId,
          targetChainId,
          preValidatedAmount: amount.toString(),
          preValidatedAmountEth: (Number(amount) / 1e18).toFixed(6),
          effectiveAmount: effectiveAmount.toString(),
          effectiveAmountEth: (Number(effectiveAmount) / 1e18).toFixed(6),
          inputRequired: inputRequired.toString(),
          expectedOutput: quote.toAmount.toString(),
          expectedOutputEth: (Number(quote.toAmount) / 1e18).toFixed(6),
          gasCosts: quote.gasCosts.toString(),
          feeCosts: quote.feeCosts.toString(),
          intentId: intent.id,
          adjustedForMinViable: effectiveAmount > amount,
        },
        'Executing inventory movement via LiFi with pre-validated amount',
      );

      this.logger.debug(
        {
          quoteId: quote.id,
          tool: quote.tool,
          fromAmount: quote.fromAmount.toString(),
          toAmount: quote.toAmount.toString(),
          toAmountMin: quote.toAmountMin.toString(),
          executionDuration: quote.executionDuration,
          gasCosts: quote.gasCosts.toString(),
          feeCosts: quote.feeCosts.toString(),
        },
        'Received LiFi quote for inventory movement',
      );

      // Get the signer for the source chain (use inventory signer if available)
      const signingProvider =
        this.config.inventoryMultiProvider ?? this.multiProvider;
      const signer = signingProvider.getSigner(sourceChain);

      // Execute the bridge transfer
      const result = await this._bridge.execute(quote, signer);

      this.logger.info(
        {
          sourceChain,
          targetChain,
          txHash: result.txHash,
          intentId: intent.id,
        },
        'Inventory movement transaction executed',
      );

      // Create the inventory_movement action for tracking
      // Use inputRequired as that's what we're actually sending
      await this.actionTracker.createRebalanceAction({
        intentId: intent.id,
        origin: this.multiProvider.getDomainId(sourceChain),
        destination: this.multiProvider.getDomainId(targetChain),
        amount: inputRequired,
        type: 'inventory_movement',
        txHash: result.txHash,
      });

      // Track consumed inventory on source chain for this cycle
      const currentConsumed = this.consumedInventory.get(sourceChain) ?? 0n;
      this.consumedInventory.set(sourceChain, currentConsumed + inputRequired);

      this.logger.debug(
        {
          sourceChain,
          amountConsumed: inputRequired.toString(),
          totalConsumed: (currentConsumed + inputRequired).toString(),
        },
        'Updated consumed inventory after LiFi bridge',
      );

      return { success: true, txHash: result.txHash };
    } catch (error) {
      this.logger.error(
        {
          sourceChain,
          targetChain,
          amount: amount.toString(),
          intentId: intent.id,
          error: (error as Error).message,
        },
        'Failed to execute inventory movement',
      );

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }
}
