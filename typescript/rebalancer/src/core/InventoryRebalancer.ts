import type { Logger } from 'pino';

import {
  type ChainName,
  HyperlaneCore,
  type InterchainGasQuote,
  type IToken,
  type MultiProtocolSignerSignerAccountInfo,
  type MultiProvider,
  Token,
  ProviderType,
  SealevelCoreAdapter,
  TOKEN_COLLATERALIZED_STANDARDS,
  type TokenAmount,
  type WarpTypedTransaction,
  type WarpCore,
  WarpTxCategory,
  getSignerForChain,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  ensure0x,
  fromWei,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../config/types.js';
import type {
  ExternalBridgeRegistry,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import type {
  IInventoryRebalancer,
  InventoryExecutionResult,
  RebalancerType,
} from '../interfaces/IRebalancer.js';
import type { InventoryRoute } from '../interfaces/IStrategy.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type {
  PartialInventoryIntent,
  RebalanceIntent,
} from '../tracking/types.js';
import {
  MIN_VIABLE_COST_MULTIPLIER,
  calculateTransferCosts,
} from '../utils/gasEstimation.js';
import {
  getExternalBridgeTokenAddress,
  isNativeTokenStandard,
} from '../utils/tokenUtils.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';
import { toProtocolTransaction } from '../utils/transactionUtils.js';
import {
  alignLocalToCanonical,
  denormalizeToLocal,
  normalizeToCanonical,
} from '../utils/balanceUtils.js';

/**
 * Buffer percentage to add when bridging inventory.
 * Bridges (amount * (100 + BRIDGE_BUFFER_PERCENT)) / 100 to account for slippage.
 */
const BRIDGE_BUFFER_PERCENT = 5n;

/**
 * Multiplier applied to LiFi's quoted gas costs.
 * LiFi consistently underestimates gas, and gas prices can spike significantly
 * between quote and execution. Using 20x provides headroom for volatility
 * (historically LiFi underestimates by ~14x).
 */
const GAS_COST_MULTIPLIER = 20n;

/**
 * Maximum percentage of inventory that gas costs can consume for a bridge to be viable.
 * If gas exceeds this threshold, the bridge is not economically worthwhile.
 */
const MAX_GAS_PERCENT_THRESHOLD = 10n;

type BridgeCapacity = {
  maxSourceInput: bigint;
  maxTargetOutput: bigint;
};

/**
 * Configuration for the InventoryRebalancer.
 */
export interface InventorySignerConfig {
  /** Signer address for this protocol */
  address: string;
  /** Private key for signing (optional - absent in monitor-only mode) */
  key?: string;
}

export interface InventoryRebalancerConfig {
  /** Signer config per protocol (address + optional key) */
  inventorySigners: Partial<Record<ProtocolType, InventorySignerConfig>>;
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
  public readonly rebalancerType: RebalancerType = 'inventory';
  private readonly logger: Logger;
  private readonly config: InventoryRebalancerConfig;
  private readonly actionTracker: IActionTracker;
  private readonly externalBridgeRegistry: Partial<ExternalBridgeRegistry>;
  private readonly warpCore: WarpCore;
  private readonly multiProvider: MultiProvider;

  /**
   * Internal balance storage for inventory tracking.
   * Updated via setInventoryBalances() before each rebalance cycle.
   */
  private inventoryBalances: Map<ChainName, bigint> = new Map();

  /**
   * Tracks inventory consumed during the current execution cycle.
   * Cleared at the start of each execute() call.
   * Used to prevent over-execution when multiple routes withdraw from the same chain.
   */
  private consumedInventory: Map<ChainName, bigint> = new Map();

  constructor(
    config: InventoryRebalancerConfig,
    actionTracker: IActionTracker,
    externalBridgeRegistry: Partial<ExternalBridgeRegistry>,
    warpCore: WarpCore,
    multiProvider: MultiProvider,
    logger: Logger,
  ) {
    this.config = config;
    this.actionTracker = actionTracker;
    this.externalBridgeRegistry = externalBridgeRegistry;
    this.warpCore = warpCore;
    this.multiProvider = multiProvider;
    this.logger = logger;

    // Validate that all tokens are collateral-backed
    // Synthetic tokens cannot be used with inventory rebalancing because:
    // - transferRemote on synthetics mints new tokens (doesn't transfer collateral)
    // - There's no collateral to deposit/withdraw
    this.validateCollateralBackedTokens();

    const redactedInventorySigners = Object.fromEntries(
      Object.entries(config.inventorySigners).map(
        ([protocol, signerConfig]) => [
          protocol,
          signerConfig ? { address: signerConfig.address } : signerConfig,
        ],
      ),
    );

    this.logger.info(
      { inventorySigners: redactedInventorySigners },
      'InventoryRebalancer initialized',
    );
  }

  /**
   * Get bridge instance by type from registry.
   * Throws if bridge type not found.
   */
  private getExternalBridge(type: ExternalBridgeType): IExternalBridge {
    const externalBridge = this.externalBridgeRegistry[type];
    if (!externalBridge) {
      throw new Error(`Bridge type '${type}' not found in registry`);
    }
    return externalBridge;
  }

  private getNativeTokenAddress(bridgeType: ExternalBridgeType): string {
    const bridge = this.getExternalBridge(bridgeType);
    const addr = bridge.getNativeTokenAddress?.();
    if (!addr) {
      throw new Error(
        `Bridge '${bridge.externalBridgeId}' does not support getNativeTokenAddress()`,
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
   * Get the token for a specific chain from WarpCore.
   */
  private getTokenForChain(chainName: ChainName) {
    return this.warpCore.tokens.find((t) => t.chainName === chainName);
  }

  private getProtocolForChain(chainName: ChainName): ProtocolType {
    const metadata =
      this.warpCore.multiProvider.getChainMetadata?.(chainName) ?? undefined;
    assert(metadata, `No chain metadata found for chain ${chainName}`);
    assert(
      metadata.protocol,
      `No protocol type in metadata for chain ${chainName}`,
    );
    return metadata.protocol;
  }

  private getInventorySignerAddress(chainName: ChainName): string {
    const protocol = this.getProtocolForChain(chainName);
    const signerConfig = this.config.inventorySigners[protocol];
    assert(
      signerConfig?.address,
      `Missing inventory signer address for protocol ${protocol} (chain ${chainName})`,
    );
    return signerConfig.address;
  }

  /**
   * Set inventory balances from external source.
   * Called before each rebalance cycle to update internal state.
   */
  setInventoryBalances(balances: Record<ChainName, bigint>): void {
    this.inventoryBalances = new Map(Object.entries(balances));
    this.logger.debug(
      {
        chains: Array.from(this.inventoryBalances.keys()),
        balances: Object.fromEntries(
          Array.from(this.inventoryBalances.entries()).map(
            ([chain, balance]) => [chain, balance.toString()],
          ),
        ),
      },
      'Updated inventory balances',
    );
  }

  /**
   * Get available inventory for a chain.
   * Returns 0n for unknown chains.
   */
  private getAvailableInventory(chain: ChainName): bigint {
    return this.inventoryBalances.get(chain) ?? 0n;
  }

  /**
   * Get all inventory balances.
   */
  private getBalances(): Map<ChainName, bigint> {
    return this.inventoryBalances;
  }

  /**
   * Calculate total inventory across all chains, excluding specified chains.
   */
  private getTotalInventory(excludeChains: ChainName[]): bigint {
    const excludeSet = new Set(excludeChains);
    let total = 0n;
    for (const [chain, balance] of this.inventoryBalances) {
      if (!excludeSet.has(chain)) {
        total += balance;
      }
    }
    return total;
  }

  private formatLocalAmount(amount: bigint, token: Token): string {
    return fromWei(amount.toString(), token.decimals);
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
  private getEffectiveAvailableInventory(chain: ChainName): bigint {
    const cached = this.getAvailableInventory(chain);
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
  async rebalance(
    routes: InventoryRoute[],
  ): Promise<InventoryExecutionResult[]> {
    this.consumedInventory.clear();

    // 1. Check for existing in_progress intent
    const activeIntent = await this.getActiveInventoryIntent();

    if (activeIntent) {
      if (activeIntent.hasInflightDeposit) {
        this.logger.info(
          {
            intentId: activeIntent.intent.id,
            remaining: activeIntent.remaining.toString(),
          },
          'Active intent has in-flight deposit, waiting for delivery before continuing',
        );
        return [];
      }
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
      externalBridge: route.externalBridge,
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
      executionType: 'inventory',
      externalBridge: intent.externalBridge!,
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
        canonicalAmount: amount.toString(),
        intentId: intent.id,
      },
      'Executing inventory route',
    );

    const sourceToken = this.getTokenForChain(destination);
    assert(sourceToken, `No token found for source chain: ${destination}`);
    const requestedLocalAmount = denormalizeToLocal(amount, sourceToken);

    // Check available inventory on the DESTINATION (deficit) chain
    // We need inventory here because transferRemote is called FROM this chain
    const availableInventory = this.getEffectiveAvailableInventory(destination);

    this.logger.info(
      {
        checkingChain: destination,
        availableInventory: availableInventory.toString(),
        availableInventoryFormatted: this.formatLocalAmount(
          availableInventory,
          sourceToken,
        ),
        requiredAmount: requestedLocalAmount.toString(),
        requiredAmountFormatted: this.formatLocalAmount(
          requestedLocalAmount,
          sourceToken,
        ),
      },
      'Checking effective inventory on destination (deficit) chain',
    );

    // Calculate transfer costs including max transferable and min viable amounts
    // transferRemote is called FROM destination TO origin (swapped direction)
    const costs = await calculateTransferCosts(
      destination, // FROM chain (where transferRemote is called)
      origin, // TO chain (where Hyperlane message goes)
      availableInventory,
      requestedLocalAmount,
      this.multiProvider,
      this.warpCore.multiProvider,
      this.getTokenForChain.bind(this),
      this.getInventorySignerAddress(destination),
      isNativeTokenStandard,
      this.logger,
    );
    const { maxTransferable, minViableTransfer } = costs;

    // Calculate total inventory across all chains
    // Note: consumedInventory tracking is handled separately within this cycle
    const totalInventory = this.getTotalInventory([]);

    this.logger.info(
      {
        fromChain: destination,
        toChain: origin,
        availableInventoryFormatted: this.formatLocalAmount(
          availableInventory,
          sourceToken,
        ),
        requestedAmountFormatted: this.formatLocalAmount(
          requestedLocalAmount,
          sourceToken,
        ),
        maxTransferableFormatted: this.formatLocalAmount(
          maxTransferable,
          sourceToken,
        ),
        minViableTransferFormatted: this.formatLocalAmount(
          minViableTransfer,
          sourceToken,
        ),
        canFullyFulfill: maxTransferable >= requestedLocalAmount,
        canPartialFulfill: maxTransferable >= minViableTransfer,
        totalInventory: totalInventory.toString(),
      },
      'Calculated max transferable amount with cost-based threshold',
    );

    // Early exit: If remaining amount is below minViableTransfer, complete the intent
    // This prevents infinite loops when the remaining amount is too small to economically bridge
    if (requestedLocalAmount < minViableTransfer) {
      this.logger.info(
        {
          intentId: intent.id,
          amount: requestedLocalAmount.toString(),
          minViableTransfer: minViableTransfer.toString(),
        },
        'Remaining amount below minViableTransfer, completing intent with acceptable loss',
      );

      await this.actionTracker.completeRebalanceIntent(intent.id);

      return {
        route,
        success: true,
        reason: 'completed_with_acceptable_loss',
      };
    }

    // Swap the route for executeTransferRemote: destination → origin
    // This ensures transferRemote is called FROM destination, ADDING collateral there
    const swappedRoute: InventoryRoute = {
      ...route,
      origin: destination, // transferRemote called FROM here
      destination: origin, // Hyperlane message goes TO here
      amount: requestedLocalAmount,
    };

    if (maxTransferable >= requestedLocalAmount) {
      // Sufficient inventory on destination - execute transferRemote directly
      const fulfilledCanonicalAmount = normalizeToCanonical(
        requestedLocalAmount,
        sourceToken,
      );
      const result = await this.executeTransferRemote(
        swappedRoute,
        intent,
        costs.gasQuote!,
        fulfilledCanonicalAmount,
      );
      // Return original strategy route in result (not the swapped execution route)
      return { ...result, route };
    } else if (maxTransferable > 0n && maxTransferable >= minViableTransfer) {
      // Partial transfer: Transfer available inventory when economically viable
      const alignedExecution = alignLocalToCanonical(
        maxTransferable,
        sourceToken,
      );
      if (alignedExecution.messageAmount === 0n) {
        this.logger.info(
          {
            intentId: intent.id,
            maxTransferable: maxTransferable.toString(),
          },
          'Skipping partial transferRemote because available local amount cannot produce canonical progress',
        );
      } else {
        const partialSwappedRoute: InventoryRoute = {
          ...swappedRoute,
          amount: alignedExecution.localAmount,
        };
        const result = await this.executeTransferRemote(
          partialSwappedRoute,
          intent,
          costs.gasQuote!,
          alignedExecution.messageAmount,
        );

        this.logger.info(
          {
            intentId: intent.id,
            partialAmount: alignedExecution.localAmount.toString(),
            partialAmountCanonical: alignedExecution.messageAmount.toString(),
            requestedAmount: requestedLocalAmount.toString(),
            requestedAmountCanonical: amount.toString(),
            remainingAmountCanonical: (amount > alignedExecution.messageAmount
              ? amount - alignedExecution.messageAmount
              : 0n
            ).toString(),
          },
          'Executed partial inventory deposit, remaining will be handled in future cycles',
        );

        // Return original strategy route in result (not the swapped execution route)
        return { ...result, route };
      }
    }

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
    const allSources = this.selectAllSourceChains(destination);

    if (allSources.length === 0) {
      this.logger.warn(
        {
          origin,
          destination,
          amount: requestedLocalAmount.toString(),
          intentId: intent.id,
        },
        'No inventory available on any monitored chain',
      );

      return {
        route,
        success: false,
        error: 'No inventory available on any monitored chain',
      };
    }

    // Calculate source capacities in destination-local units.
    const viableSources: Array<{
      chain: ChainName;
      maxSourceInput: bigint;
      maxTargetOutput: bigint;
    }> = [];

    for (const source of allSources) {
      const capacity = await this.calculateBridgeCapacity(
        source.chain,
        destination,
        source.availableAmount,
        route.externalBridge,
      );

      if (capacity.maxTargetOutput > 0n) {
        viableSources.push({ chain: source.chain, ...capacity });
      }
    }

    // Sort by destination output descending.
    viableSources.sort((a, b) =>
      a.maxTargetOutput > b.maxTargetOutput ? -1 : 1,
    );

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
        success: false,
        error: 'No viable bridge sources available',
      };
    }

    // Create bridge plans using destination-local output amounts.
    const targetWithBuffer =
      ((requestedLocalAmount + costs.totalCost) *
        (100n + BRIDGE_BUFFER_PERCENT)) /
      100n;
    const bridgePlans: Array<{
      chain: ChainName;
      maxSourceInput: bigint;
      targetOutput: bigint;
    }> = [];
    let totalPlanned = 0n;

    for (const source of viableSources) {
      if (totalPlanned >= targetWithBuffer) break;

      const remaining = targetWithBuffer - totalPlanned;
      const targetOutput =
        source.maxTargetOutput >= remaining
          ? remaining
          : source.maxTargetOutput;

      bridgePlans.push({
        chain: source.chain,
        maxSourceInput: source.maxSourceInput,
        targetOutput,
      });
      totalPlanned += targetOutput;
    }

    this.logger.info(
      {
        targetChain: destination,
        viableSources: viableSources.map((s) => ({
          chain: s.chain,
          maxSourceInput: s.maxSourceInput.toString(),
          maxTargetOutput: s.maxTargetOutput.toString(),
        })),
        bridgePlans: bridgePlans.map((p) => ({
          chain: p.chain,
          maxSourceInput: p.maxSourceInput.toString(),
          targetOutput: p.targetOutput.toString(),
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
          plan.targetOutput,
          plan.maxSourceInput,
          intent,
          route.externalBridge,
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
        totalBridged += plan.targetOutput;
        this.logger.info(
          {
            sourceChain: plan.chain,
            amount: plan.targetOutput.toString(),
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
          {
            sourceChain: plan.chain,
            amount: plan.targetOutput.toString(),
            error,
          },
          'Inventory movement failed',
        );
      }
    }

    if (successCount === 0) {
      const errorDetails =
        failedErrors.length > 0 ? ` (${failedErrors.join('; ')})` : '';
      return {
        route,
        success: false,
        error: `All inventory movements failed${errorDetails}`,
      };
    }

    this.logger.info(
      {
        targetChain: destination,
        successCount,
        totalBridged: totalBridged.toString(),
        targetAmount: requestedLocalAmount.toString(),
        targetAmountCanonical: amount.toString(),
        intentId: intent.id,
      },
      'Parallel inventory movements completed, transferRemote will execute after bridges complete',
    );

    return { route, success: true };
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
    gasQuote: InterchainGasQuote,
    fulfilledCanonicalAmount: bigint,
  ): Promise<InventoryExecutionResult> {
    const { origin, destination, amount } = route;

    const originToken = this.getTokenForChain(origin);
    if (!originToken) {
      throw new Error(`No token found for origin chain: ${origin}`);
    }

    const destinationDomain = this.multiProvider.getDomainId(destination);

    this.logger.debug(
      {
        origin,
        destination,
        amount: amount.toString(),
        gasQuote: {
          igpQuote: gasQuote.igpQuote.amount.toString(),
          tokenFeeQuote: gasQuote.tokenFeeQuote?.amount?.toString() ?? 'none',
        },
      },
      'Using pre-calculated gas quote for transferRemote',
    );

    // Convert pre-calculated gas quote to TokenAmount for WarpCore
    const originChainMetadata = this.multiProvider.getChainMetadata(origin);
    const igpAddressOrDenom = gasQuote.igpQuote.addressOrDenom;
    let igpToken: IToken;
    if (!igpAddressOrDenom || isZeroishAddress(igpAddressOrDenom)) {
      igpToken = Token.FromChainMetadataNativeToken(originChainMetadata);
    } else {
      const searchResult = this.warpCore.findToken(origin, igpAddressOrDenom);
      assert(searchResult, `IGP fee token ${igpAddressOrDenom} is unknown`);
      igpToken = searchResult;
    }
    const interchainFee: TokenAmount<IToken> = igpToken.amount(
      gasQuote.igpQuote.amount,
    );

    let tokenFeeQuote: TokenAmount<IToken> | undefined;
    if (gasQuote.tokenFeeQuote?.amount) {
      const feeAddress = gasQuote.tokenFeeQuote.addressOrDenom;
      const feeToken: IToken =
        !feeAddress || isZeroishAddress(feeAddress)
          ? Token.FromChainMetadataNativeToken(originChainMetadata)
          : originToken;
      tokenFeeQuote = feeToken.amount(gasQuote.tokenFeeQuote.amount);
    }

    const originTokenAmount = originToken.amount(amount);
    const transferTxs = await this.warpCore.getTransferRemoteTxs({
      originTokenAmount,
      destination,
      sender: this.getInventorySignerAddress(origin),
      recipient: this.getInventorySignerAddress(destination),
      interchainFee,
      tokenFeeQuote,
    });
    assert(
      transferTxs.length > 0,
      'Expected at least one transaction from WarpCore',
    );

    this.logger.info(
      {
        origin,
        destination,
        amount: amount.toString(),
        transactionCount: transferTxs.length,
        intentId: intent.id,
      },
      'Sending transferRemote transactions',
    );

    let transferTxHash: string | undefined;
    for (const tx of transferTxs) {
      const { txHash } = await this.sendAndConfirmInventoryTx(origin, tx);
      if (tx.category === WarpTxCategory.Transfer) {
        transferTxHash = txHash;
      }
    }

    const messageId = transferTxHash
      ? await this.extractDispatchedMessageId(origin, transferTxHash)
      : undefined;

    assert(transferTxHash, 'No transfer transaction hash found');

    if (!messageId) {
      this.logger.warn(
        {
          origin,
          destination,
          txHash: transferTxHash,
          intentId: intent.id,
        },
        'TransferRemote transaction sent but no messageId found in logs',
      );
    }

    this.logger.info(
      {
        origin,
        destination,
        txHash: transferTxHash,
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
      amount: fulfilledCanonicalAmount,
      type: 'inventory_deposit',
      txHash: transferTxHash,
      messageId,
    });

    return {
      route,
      success: true,
      amountSent: amount,
    };
  }

  private async sendAndConfirmInventoryTx(
    chain: ChainName,
    typedTx: WarpTypedTransaction,
  ): Promise<{ txHash: string }> {
    const protocol = this.getProtocolForChain(chain);
    const signerConfig = this.config.inventorySigners[protocol];
    assert(
      signerConfig?.key,
      `Missing signer key for protocol ${protocol} (chain ${chain})`,
    );

    const accountConfig = this.buildSignerAccountConfig(
      protocol,
      signerConfig.key,
      chain,
    );
    const signer = await getSignerForChain(
      chain,
      accountConfig,
      this.warpCore.multiProvider,
    );

    const metadata = this.warpCore.multiProvider.getChainMetadata(chain);
    const configuredConfirmations =
      metadata.blocks?.reorgPeriod ?? metadata.blocks?.confirmations;
    let waitConfirmations = 1;
    if (typeof configuredConfirmations === 'number') {
      waitConfirmations = configuredConfirmations;
    }

    const txHash = await signer.sendAndConfirmTransaction(
      toProtocolTransaction(typedTx, protocol),
      { waitConfirmations },
    );
    return { txHash };
  }

  private buildSignerAccountConfig(
    protocol: ProtocolType,
    key: string,
    chain: ChainName,
  ): MultiProtocolSignerSignerAccountInfo {
    void chain;
    switch (protocol) {
      case ProtocolType.Ethereum:
        return { protocol, privateKey: ensure0x(key) };
      case ProtocolType.Sealevel:
        return { protocol, privateKey: parseSolanaPrivateKey(key) };
      default:
        throw new Error(
          `Unsupported protocol ${protocol} for inventory signer`,
        );
    }
  }

  protected async extractDispatchedMessageId(
    origin: ChainName,
    txHash: string,
  ): Promise<string | undefined> {
    const receipt = await this.getTransactionReceipt(origin, txHash);
    if (!receipt) return undefined;

    if (receipt.type === ProviderType.EthersV5) {
      return HyperlaneCore.getDispatchedMessages(receipt.receipt)[0]?.id;
    }

    if (receipt.type === ProviderType.SolanaWeb3) {
      const logs = receipt.receipt.meta?.logMessages;
      if (!logs) return undefined;
      const parsed = SealevelCoreAdapter.parseMessageDispatchLogs(logs);
      return parsed[0]?.messageId ? ensure0x(parsed[0].messageId) : undefined;
    }

    return undefined;
  }

  private async getTransactionReceipt(
    origin: ChainName,
    txHash: string,
  ): Promise<TypedTransactionReceipt | undefined> {
    try {
      const protocol = this.getProtocolForChain(origin);

      if (protocol === ProtocolType.Ethereum) {
        const provider =
          this.warpCore.multiProvider.getEthersV5Provider(origin);
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) return undefined;
        return { type: ProviderType.EthersV5, receipt };
      }

      if (protocol === ProtocolType.Sealevel) {
        const provider =
          this.warpCore.multiProvider.getSolanaWeb3Provider(origin);
        const receipt = await provider.getTransaction(txHash, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!receipt) return undefined;
        return { type: ProviderType.SolanaWeb3, receipt };
      }
    } catch (error) {
      this.logger.debug(
        { origin, txHash, error: (error as Error).message },
        'Unable to fetch typed transaction receipt',
      );
    }

    return undefined;
  }

  /**
   * Select all source chains with available inventory for bridging.
   * Returns sources sorted by available amount (highest first).
   */
  private selectAllSourceChains(
    targetChain: ChainName,
  ): Array<{ chain: ChainName; availableAmount: bigint }> {
    const balances = this.getBalances();
    const sources: Array<{ chain: ChainName; availableAmount: bigint }> = [];

    for (const [chainName, balance] of balances) {
      if (chainName === targetChain) continue;

      const consumed = this.consumedInventory.get(chainName) ?? 0n;
      const effectiveAvailable = balance > consumed ? balance - consumed : 0n;

      if (effectiveAvailable > 0n) {
        sources.push({
          chain: chainName,
          availableAmount: effectiveAvailable,
        });
      }
    }

    // Sort by available amount descending (bridge from largest sources first)
    return sources.sort((a, b) =>
      a.availableAmount > b.availableAmount ? -1 : 1,
    );
  }

  /**
   * Calculate the bridge capacity from a source chain in destination-local units.
   * Uses LiFi quotes to conservatively estimate the destination output available
   * from the source chain's current local inventory.
   *
   * For native-token sources, gas is reserved from the source inventory and the
   * output capacity is re-quoted from the remaining source input.
   */
  private async calculateBridgeCapacity(
    sourceChain: ChainName,
    targetChain: ChainName,
    rawInventory: bigint,
    externalBridgeType: ExternalBridgeType,
  ): Promise<BridgeCapacity> {
    const sourceToken = this.getTokenForChain(sourceChain);
    const targetToken = this.getTokenForChain(targetChain);
    assert(sourceToken, `No token found for source chain: ${sourceChain}`);
    assert(targetToken, `No token found for target chain: ${targetChain}`);

    // Convert HypNative token addresses to the external bridge's native token representation
    const fromTokenAddress = getExternalBridgeTokenAddress(
      sourceToken,
      externalBridgeType,
      this.getNativeTokenAddress.bind(this),
    );
    const toTokenAddress = getExternalBridgeTokenAddress(
      targetToken,
      externalBridgeType,
      this.getNativeTokenAddress.bind(this),
    );

    const sourceChainId = Number(this.multiProvider.getChainId(sourceChain));
    const targetChainId = Number(this.multiProvider.getChainId(targetChain));

    try {
      const externalBridge = this.getExternalBridge(externalBridgeType);
      const initialQuote = await externalBridge.quote({
        fromChain: sourceChainId,
        toChain: targetChainId,
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        fromAmount: rawInventory,
        fromAddress: this.getInventorySignerAddress(sourceChain),
        toAddress: this.getInventorySignerAddress(targetChain),
      });

      let maxSourceInput = rawInventory;
      let outputQuote = initialQuote;

      if (isNativeTokenStandard(sourceToken.standard)) {
        const estimatedGas = initialQuote.gasCosts * GAS_COST_MULTIPLIER;
        const maxGasThreshold = rawInventory / MAX_GAS_PERCENT_THRESHOLD;
        if (estimatedGas > maxGasThreshold) {
          this.logger.info(
            {
              sourceChain,
              targetChain,
              rawInventory: rawInventory.toString(),
              quotedGas: initialQuote.gasCosts.toString(),
              estimatedGas: estimatedGas.toString(),
              maxGasThreshold: maxGasThreshold.toString(),
            },
            'Bridge not viable - gas cost exceeds 10% of inventory',
          );
          return { maxSourceInput: 0n, maxTargetOutput: 0n };
        }

        maxSourceInput = rawInventory - estimatedGas;
        if (maxSourceInput <= 0n) {
          return { maxSourceInput: 0n, maxTargetOutput: 0n };
        }

        outputQuote = await externalBridge.quote({
          fromChain: sourceChainId,
          toChain: targetChainId,
          fromToken: fromTokenAddress,
          toToken: toTokenAddress,
          fromAmount: maxSourceInput,
          fromAddress: this.getInventorySignerAddress(sourceChain),
          toAddress: this.getInventorySignerAddress(targetChain),
        });
      }

      this.logger.info(
        {
          sourceChain,
          targetChain,
          rawInventory: rawInventory.toString(),
          maxSourceInput: maxSourceInput.toString(),
          maxTargetOutput: outputQuote.toAmountMin.toString(),
        },
        'Calculated bridge capacity',
      );

      return {
        maxSourceInput,
        maxTargetOutput: outputQuote.toAmountMin,
      };
    } catch (error) {
      this.logger.warn(
        {
          sourceChain,
          targetChain,
          error: (error as Error).message,
        },
        'Failed to calculate bridge capacity, skipping chain',
      );
      return { maxSourceInput: 0n, maxTargetOutput: 0n };
    }
  }

  /**
   * Execute inventory movement from source chain to target chain via LiFi bridge.
   *
   * Uses reverse quotes (`toAmount`) so plans are expressed in target-chain local
   * units and source-local spend is discovered by the bridge quote.
   *
   * @param sourceChain - Chain to move inventory from
   * @param targetChain - Chain to move inventory to (origin chain for rebalancing)
   * @param targetOutputAmount - Destination-local amount to receive
   * @param maxSourceInput - Maximum source-local amount available for this plan
   * @param intent - Rebalance intent for tracking
   * @param externalBridgeType - External bridge type to use
   * @returns Result with success status and optional txHash/error
   */
  private async executeInventoryMovement(
    sourceChain: ChainName,
    targetChain: ChainName,
    targetOutputAmount: bigint,
    maxSourceInput: bigint,
    intent: RebalanceIntent,
    externalBridgeType: ExternalBridgeType,
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

    // Convert HypNative token addresses to the external bridge's native token representation
    // For HypNative tokens, addressOrDenom is the warp route contract, not the native token
    const fromTokenAddress = getExternalBridgeTokenAddress(
      sourceToken,
      externalBridgeType,
      this.getNativeTokenAddress.bind(this),
    );

    const toTokenAddress = getExternalBridgeTokenAddress(
      targetToken,
      externalBridgeType,
      this.getNativeTokenAddress.bind(this),
    );

    this.logger.debug(
      {
        sourceTokenStandard: sourceToken.standard,
        targetTokenStandard: targetToken.standard,
        fromTokenAddress,
        toTokenAddress,
      },
      'Resolved token addresses for LiFi bridge',
    );

    try {
      const externalBridge = this.getExternalBridge(externalBridgeType);
      const quote = await externalBridge.quote({
        fromChain: sourceChainId,
        toChain: targetChainId,
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        toAmount: targetOutputAmount,
        fromAddress: this.getInventorySignerAddress(sourceChain),
        toAddress: this.getInventorySignerAddress(targetChain),
      });

      const inputRequired = quote.fromAmount;
      if (inputRequired > maxSourceInput) {
        return {
          success: false,
          error: `Bridge input ${inputRequired} exceeded planned source capacity ${maxSourceInput}`,
        };
      }

      this.logger.info(
        {
          sourceChain,
          targetChain,
          sourceChainId,
          targetChainId,
          requestedTargetOutput: targetOutputAmount.toString(),
          requestedTargetOutputFormatted: this.formatLocalAmount(
            targetOutputAmount,
            targetToken,
          ),
          inputRequired: inputRequired.toString(),
          inputRequiredFormatted: this.formatLocalAmount(
            inputRequired,
            sourceToken,
          ),
          expectedOutput: quote.toAmount.toString(),
          expectedOutputMin: quote.toAmountMin.toString(),
          expectedOutputFormatted: this.formatLocalAmount(
            quote.toAmount,
            targetToken,
          ),
          gasCosts: quote.gasCosts.toString(),
          feeCosts: quote.feeCosts.toString(),
          intentId: intent.id,
        },
        'Executing inventory movement via LiFi reverse quote',
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

      // Build private keys map from all available inventory signers
      const privateKeys: Partial<Record<ProtocolType, string>> = {};
      for (const [protocol, cfg] of Object.entries(
        this.config.inventorySigners,
      )) {
        if (cfg?.key) {
          privateKeys[protocol as ProtocolType] = cfg.key;
        }
      }
      const sourceProtocol = this.getProtocolForChain(sourceChain);
      assert(
        privateKeys[sourceProtocol],
        `Missing inventory signer key for protocol ${sourceProtocol} (chain ${sourceChain})`,
      );
      const result = await externalBridge.execute(quote, privateKeys);

      this.logger.info(
        {
          sourceChain,
          targetChain,
          txHash: result.txHash,
          intentId: intent.id,
        },
        'Inventory movement transaction executed',
      );

      // Keep bridge consumption in source-local units; intent fulfillment only
      // advances from canonical inventory_deposit amounts after transferRemote.
      await this.actionTracker.createRebalanceAction({
        intentId: intent.id,
        origin: this.multiProvider.getDomainId(sourceChain),
        destination: this.multiProvider.getDomainId(targetChain),
        amount: inputRequired,
        type: 'inventory_movement',
        txHash: result.txHash,
        externalBridgeId: externalBridgeType,
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
          amount: targetOutputAmount.toString(),
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
