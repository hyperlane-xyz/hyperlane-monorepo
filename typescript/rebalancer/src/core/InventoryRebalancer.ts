import { BigNumber } from 'ethers';
import type { Logger } from 'pino';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
  HyperlaneCore,
  type MultiProvider,
  TOKEN_COLLATERALIZED_STANDARDS,
  TokenStandard,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { addBufferToGasLimit, sleep } from '@hyperlane-xyz/utils';

import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type {
  IInventoryRebalancer,
  InventoryExecutionResult,
  InventoryRoute,
} from '../interfaces/IInventoryRebalancer.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../tracking/types.js';

/**
 * Standard address representation for native ETH in DeFi protocols (including LiFi).
 * This is the common convention used by bridges and DEXes to represent native gas tokens.
 */
const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Fallback gas limit for transferRemote when eth_estimateGas fails.
 * Conservative estimate for cross-chain token transfers.
 */
const FALLBACK_TRANSFER_REMOTE_GAS_LIMIT = 300_000n;

/**
 * Cost multiplier for minimum viable transfer.
 * A transfer must be worth at least this multiple of its cost to be worthwhile.
 */
const MIN_VIABLE_COST_MULTIPLIER = 2n;

/**
 * Minimum percentage of requested amount required for partial transfer.
 * If available inventory is below this threshold, trigger inventory movement instead.
 */
const PARTIAL_TRANSFER_THRESHOLD_PERCENT = 90n;

/**
 * Buffer percentage to add when bridging inventory.
 * Bridges (amount * (100 + BRIDGE_BUFFER_PERCENT)) / 100 to account for slippage.
 */
const BRIDGE_BUFFER_PERCENT = 5n;

/**
 * Percentage of native token balance to reserve for gas when bridging.
 * For example, 2n means reserve 2%, bridge 98%.
 *
 * This ensures sufficient native token remains to pay bridge transaction gas costs.
 * Conservative estimate: typical bridge gas is 0.5-1.5% at moderate gas prices.
 */
const NATIVE_TOKEN_GAS_RESERVE_PERCENT = 2n;

/**
 * Transfer cost estimate for native token transfers.
 * Contains all cost components needed for transfer decisions.
 */
interface TransferCostEstimate {
  /** IGP cost for the Hyperlane message */
  igpCost: bigint;
  /** Estimated gas cost for the transferRemote transaction (with buffer) */
  gasCost: bigint;
  /** Total cost = igpCost + gasCost */
  totalCost: bigint;
  /** Maximum transferable amount after reserving costs (availableInventory - totalCost) */
  maxTransferable: bigint;
  /** Minimum viable transfer (totalCost * MIN_VIABLE_COST_MULTIPLIER) */
  minViableTransfer: bigint;
  /** Gas quote from adapter (for passing to executeTransferRemote) */
  gasQuote?: {
    igpQuote: { amount: bigint };
  };
}

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
   * Check if a token's balance is the same as native gas balance.
   * For these tokens, we must reserve funds for IGP when calculating max transferable.
   */
  private isNativeTokenStandard(standard: TokenStandard): boolean {
    // EvmHypNative covers all native token types including scaled variants
    return standard === TokenStandard.EvmHypNative;
  }

  /**
   * Estimate gas for a transferRemote transaction using eth_estimateGas.
   * Falls back to conservative estimate if estimation fails.
   *
   * @param originChain - Chain where transferRemote will be called
   * @param destinationChain - Chain where the Hyperlane message goes
   * @param amount - Amount to transfer
   * @returns Estimated gas limit for the transaction
   */
  private async estimateTransferRemoteGas(
    originChain: ChainName,
    destinationChain: ChainName,
    amount: bigint,
  ): Promise<bigint> {
    const originToken = this.getTokenForChain(originChain);
    if (!originToken) {
      this.logger.warn(
        { originChain },
        'No token found for origin chain, using fallback gas limit',
      );
      return FALLBACK_TRANSFER_REMOTE_GAS_LIMIT;
    }

    try {
      const destinationDomain =
        this.multiProvider.getDomainId(destinationChain);
      const adapter = originToken.getHypAdapter(this.warpCore.multiProvider);

      // Quote the IGP gas first (needed for the full transaction)
      const gasQuote = await adapter.quoteTransferRemoteGas({
        destination: destinationDomain,
        sender: this.config.inventorySigner,
        recipient: this.config.inventorySigner,
        amount,
      });

      // Populate with minimal amount for gas estimation
      // Gas cost is independent of transfer size (just a require check in _transferFromSender),
      // and using minimal amount prevents eth_estimateGas from failing when account balance < requested amount
      // Note: getHypAdapter returns IHypTokenAdapter<unknown> for protocol-agnostic support.
      // For EVM chains (which inventory rebalancing uses), the actual type is AnnotatedEV5Transaction.
      const populatedTx = (await adapter.populateTransferRemoteTx({
        destination: destinationDomain,
        recipient: this.config.inventorySigner,
        weiAmountOrId: 1n,
        interchainGas: gasQuote,
      })) as AnnotatedEV5Transaction;

      // Estimate gas using the provider
      const provider = this.multiProvider.getProvider(originChain);
      const gasEstimate = await provider.estimateGas({
        to: populatedTx.to,
        data: populatedTx.data,
        value: populatedTx.value,
        from: this.config.inventorySigner,
      });

      const estimatedGas = BigInt(gasEstimate.toString());

      this.logger.debug(
        {
          originChain,
          destinationChain,
          amount: amount.toString(),
          estimatedGas: estimatedGas.toString(),
        },
        'Estimated transferRemote gas via eth_estimateGas',
      );

      return estimatedGas;
    } catch (error) {
      this.logger.warn(
        {
          originChain,
          destinationChain,
          error: (error as Error).message,
          fallbackGas: FALLBACK_TRANSFER_REMOTE_GAS_LIMIT.toString(),
        },
        'Gas estimation failed, using fallback gas limit',
      );
      return FALLBACK_TRANSFER_REMOTE_GAS_LIMIT;
    }
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
   * Calculate all transfer costs for a transferRemote operation.
   * Consolidates IGP costs, gas costs, and derived values (max transferable, min viable).
   *
   * @param originChain - Chain to transfer from (where transferRemote is called)
   * @param destinationChain - Chain to transfer to (Hyperlane message destination)
   * @param availableInventory - Available token balance on origin chain
   * @param requestedAmount - Requested transfer amount
   * @returns Cost estimate with all components and derived values
   */
  private async calculateTransferCosts(
    originChain: ChainName,
    destinationChain: ChainName,
    availableInventory: bigint,
    requestedAmount: bigint,
  ): Promise<TransferCostEstimate> {
    const originToken = this.getTokenForChain(originChain);
    if (!originToken) {
      throw new Error(`No token found for origin chain: ${originChain}`);
    }

    const destinationDomain = this.multiProvider.getDomainId(destinationChain);
    const adapter = originToken.getHypAdapter(this.warpCore.multiProvider);

    // Always quote IGP for the gas quote (needed for populateTransferRemoteTx)
    const gasQuote = await adapter.quoteTransferRemoteGas({
      destination: destinationDomain,
      sender: this.config.inventorySigner,
      recipient: this.config.inventorySigner,
      amount: requestedAmount,
    });

    // For non-native tokens, no cost reservation needed from token balance
    if (!this.isNativeTokenStandard(originToken.standard)) {
      return {
        igpCost: 0n,
        gasCost: 0n,
        totalCost: 0n,
        maxTransferable:
          availableInventory < requestedAmount
            ? availableInventory
            : requestedAmount,
        minViableTransfer: 0n,
        gasQuote,
      };
    }

    // For native tokens, calculate costs
    const igpCost = gasQuote.igpQuote.amount;

    // Estimate gas with buffer
    const estimatedGasLimit = await this.estimateTransferRemoteGas(
      originChain,
      destinationChain,
      requestedAmount,
    );
    const bufferedGasLimit = addBufferToGasLimit(
      BigNumber.from(estimatedGasLimit.toString()),
    );

    // Get gas price and calculate cost
    const provider = this.multiProvider.getProvider(originChain);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasCost = bufferedGasLimit.toBigInt() * BigInt(gasPrice.toString());

    const totalCost = igpCost + gasCost;

    // Calculate derived values
    let maxTransferable: bigint;
    if (availableInventory <= totalCost) {
      maxTransferable = 0n;
    } else {
      const maxAfterReservation = availableInventory - totalCost;
      maxTransferable =
        maxAfterReservation < requestedAmount
          ? maxAfterReservation
          : requestedAmount;
    }

    const minViableTransfer = totalCost * MIN_VIABLE_COST_MULTIPLIER;

    this.logger.debug(
      {
        originChain,
        destinationChain,
        availableInventory: availableInventory.toString(),
        requestedAmount: requestedAmount.toString(),
        igpCost: igpCost.toString(),
        gasCost: gasCost.toString(),
        totalCost: totalCost.toString(),
        maxTransferable: maxTransferable.toString(),
        minViableTransfer: minViableTransfer.toString(),
      },
      'Calculated transfer costs for native token',
    );

    return {
      igpCost,
      gasCost,
      totalCost,
      maxTransferable,
      minViableTransfer,
      gasQuote,
    };
  }

  /**
   * Execute inventory-based rebalances for the given routes.
   */
  async execute(
    routes: InventoryRoute[],
    intents: RebalanceIntent[],
  ): Promise<InventoryExecutionResult[]> {
    const results: InventoryExecutionResult[] = [];

    // Clear consumed inventory tracking at the start of each execution cycle
    // This ensures fresh tracking for each batch of routes
    this.consumedInventory.clear();

    // Process each route with its corresponding intent
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const intent = intents[i];

      if (!intent) {
        this.logger.error({ route }, 'No intent found for route, skipping');
        continue;
      }

      try {
        const result = await this.executeRoute(route, intent);
        results.push(result);

        // Update consumed inventory on success
        // Track on DESTINATION chain since that's where we call transferRemote FROM
        // (inventory flows: destination chain → origin chain via Hyperlane message)
        if (result.success && result.amountSent) {
          const current = this.consumedInventory.get(route.destination) ?? 0n;
          this.consumedInventory.set(
            route.destination,
            current + result.amountSent,
          );

          this.logger.debug(
            {
              chain: route.destination,
              amountConsumed: result.amountSent.toString(),
              totalConsumed: (current + result.amountSent).toString(),
            },
            'Updated consumed inventory after successful execution',
          );
        }
      } catch (error) {
        this.logger.error(
          {
            route,
            intentId: intent.id,
            error: (error as Error).message,
          },
          'Failed to execute inventory route',
        );

        results.push({
          route,
          intent,
          success: false,
          error: (error as Error).message,
        });
      }
    }

    return results;
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
    const costs = await this.calculateTransferCosts(
      destination, // FROM chain (where transferRemote is called)
      origin, // TO chain (where Hyperlane message goes)
      availableInventory,
      amount,
    );
    const { maxTransferable, minViableTransfer } = costs;

    // Calculate total inventory across all chains (excluding origin which is surplus chain)
    // Note: consumedInventory tracking is handled separately within this cycle
    const totalInventory = await this.inventoryMonitor.getTotalInventory([
      origin,
    ]);

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
    } else if (
      amount > totalInventory && // Need looping - not enough total inventory
      maxTransferable >=
        (totalInventory * PARTIAL_TRANSFER_THRESHOLD_PERCENT) / 100n // 90% consolidated
    ) {
      // Partial transfer: Only when looping is required AND 90%+ of total inventory
      // is consolidated on the current (destination) chain
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
          totalInventory: totalInventory.toString(),
          consolidationRatio: `${(maxTransferable * 100n) / totalInventory}%`,
          remainingAmount: (amount - maxTransferable).toString(),
        },
        'Executed partial inventory deposit (90%+ consolidated), remaining will be handled in future cycles',
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

      // Get all available source chains for parallel bridging
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

      // Pre-compute bridge amounts from each source
      // Apply 5% buffer: bridge (100 + BRIDGE_BUFFER_PERCENT)% of needed
      const targetWithBuffer = (amount * (100n + BRIDGE_BUFFER_PERCENT)) / 100n;

      const bridgePlans: Array<{ chain: ChainName; amount: bigint }> = [];
      let totalPlanned = 0n;

      for (const source of allSources) {
        if (totalPlanned >= targetWithBuffer) break;

        const remaining = targetWithBuffer - totalPlanned;
        const amountFromSource =
          source.availableAmount >= remaining
            ? remaining
            : source.availableAmount;

        bridgePlans.push({ chain: source.chain, amount: amountFromSource });
        totalPlanned += amountFromSource;
      }

      this.logger.info(
        {
          targetChain: destination,
          bridgePlans: bridgePlans.map((p) => ({
            chain: p.chain,
            amount: p.amount.toString(),
          })),
          totalPlanned: totalPlanned.toString(),
          targetWithBuffer: targetWithBuffer.toString(),
          intentId: intent.id,
        },
        'Initiating parallel inventory movements from multiple sources',
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
          this.logger.warn(
            { sourceChain: plan.chain, amount: plan.amount.toString(), error },
            'Inventory movement failed',
          );
        }
      }

      if (successCount === 0) {
        return {
          route,
          intent,
          success: false,
          error: 'All inventory movements failed',
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
    const receipt = await signingProvider.sendTransaction(
      origin,
      populatedTx as AnnotatedEV5Transaction,
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
      'TransferRemote transaction sent',
    );

    // Wait for reorgPeriod confirmations before creating the action.
    // This ensures Monitor will see the balance change before the next strategy cycle.
    await this.waitForConfirmations(origin, receipt.transactionHash);

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
   * Execute inventory movement from source chain to target chain via LiFi bridge.
   * Uses toAmount quotes to get exact input required for desired output amount.
   *
   * @param sourceChain - Chain to move inventory from
   * @param targetChain - Chain to move inventory to (origin chain for rebalancing)
   * @param amount - Amount to receive on target chain
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

    // Get effective available inventory on source chain (accounting for prior consumption this cycle)
    const rawAvailableInventory =
      await this.getEffectiveAvailableInventory(sourceChain);

    if (rawAvailableInventory === 0n) {
      return {
        success: false,
        error: `No inventory available on ${sourceChain}`,
      };
    }

    // For native tokens, reserve 2% for gas costs
    // This ensures we have enough native token to pay for the bridge transaction
    const isNative = this.isNativeTokenStandard(sourceToken.standard);
    const availableInventory = isNative
      ? (rawAvailableInventory * (100n - NATIVE_TOKEN_GAS_RESERVE_PERCENT)) /
        100n // Reserve 2% for gas
      : rawAvailableInventory; // ERC20s don't need gas reservation

    if (isNative && availableInventory !== rawAvailableInventory) {
      const reserved = rawAvailableInventory - availableInventory;
      this.logger.info(
        {
          sourceChain,
          rawBalance: rawAvailableInventory.toString(),
          rawBalanceEth: (Number(rawAvailableInventory) / 1e18).toFixed(6),
          availableForBridge: availableInventory.toString(),
          availableForBridgeEth: (Number(availableInventory) / 1e18).toFixed(6),
          gasReserved: reserved.toString(),
          gasReservedEth: (Number(reserved) / 1e18).toFixed(6),
          reservationPercent: NATIVE_TOKEN_GAS_RESERVE_PERCENT.toString() + '%',
        },
        'Reserved gas for native token bridge',
      );
    }

    // Convert HypNative token addresses to LiFi's native ETH representation
    // For HypNative tokens, addressOrDenom is the warp route contract, not the native token
    const fromTokenAddress = this.isNativeTokenStandard(sourceToken.standard)
      ? NATIVE_TOKEN_ADDRESS
      : sourceToken.addressOrDenom;

    const toTokenAddress = this.isNativeTokenStandard(targetToken.standard)
      ? NATIVE_TOKEN_ADDRESS
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

    // TODO: lets think of a better way to avoid very small bridges
    // Calculate minViableTransfer for the target chain
    // If bridging less than this, the received amount won't be enough to execute transferRemote
    // So we over-bridge to ensure we can complete the intent in the next cycle
    const costs = await this.calculateTransferCosts(
      targetChain, // FROM chain for transferRemote (the target of this bridge)
      sourceChain, // TO chain for transferRemote (Hyperlane message destination)
      amount, // availableInventory (not used for minViableTransfer calculation)
      amount, // requestedAmount
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
      // Use toAmount quote to find exact input required for desired output
      // This replaces the old approach of reserving a fixed 5% for gas
      // Use effectiveAmount (potentially adjusted up to minViableTransfer)
      let quote = await this._bridge.quote({
        fromChain: sourceChainId,
        toChain: targetChainId,
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        toAmount: effectiveAmount, // "I want X on destination, how much do I send?"
        fromAddress: this.config.inventorySigner,
        toAddress: this.config.inventorySigner,
      });

      // Check if we can afford the required input amount
      let inputRequired = quote.fromAmount;
      let actualToAmount = effectiveAmount;

      if (inputRequired > availableInventory) {
        // Can't afford full amount - find what we can afford using fromAmount quote
        this.logger.info(
          {
            sourceChain,
            targetChain,
            requestedAmount: effectiveAmount.toString(),
            originalAmount: amount.toString(),
            inputRequired: inputRequired.toString(),
            availableInventory: availableInventory.toString(),
            intentId: intent.id,
          },
          'Cannot afford full bridge amount, quoting with available inventory',
        );

        // Quote with what we have to see what we'll get on destination
        quote = await this._bridge.quote({
          fromChain: sourceChainId,
          toChain: targetChainId,
          fromToken: fromTokenAddress,
          toToken: toTokenAddress,
          fromAmount: availableInventory, // Bridge everything we have
          fromAddress: this.config.inventorySigner,
          toAddress: this.config.inventorySigner,
        });

        inputRequired = quote.fromAmount;
        actualToAmount = quote.toAmount;
      }

      this.logger.info(
        {
          sourceChain,
          targetChain,
          sourceChainId,
          targetChainId,
          originalAmount: amount.toString(),
          effectiveAmount: effectiveAmount.toString(),
          inputRequired: inputRequired.toString(),
          expectedOutput: actualToAmount.toString(),
          availableInventory: availableInventory.toString(),
          gasCosts: quote.gasCosts.toString(),
          feeCosts: quote.feeCosts.toString(),
          intentId: intent.id,
          overBridged: effectiveAmount > amount,
        },
        'Executing inventory movement via LiFi with precise cost calculation',
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

  /**
   * Get the reorgPeriod for a chain from its metadata.
   * Returns a number (block count) or string (e.g., "finalized" for Polygon).
   */
  private getReorgPeriod(chainName: string): number | string {
    const metadata = this.multiProvider.getChainMetadata(chainName);
    return metadata.blocks?.reorgPeriod ?? 32;
  }

  /**
   * Wait for a transaction to reach reorgPeriod confirmations.
   * This ensures the transaction is in the "confirmed block" range that Monitor uses.
   */
  private async waitForConfirmations(
    chainName: string,
    txHash: string,
  ): Promise<void> {
    const reorgPeriod = this.getReorgPeriod(chainName);
    const provider = this.multiProvider.getProvider(chainName);

    // Handle string block tags (e.g., "finalized" for Polygon)
    if (typeof reorgPeriod === 'string') {
      await this.waitForFinalizedBlock(chainName, txHash, reorgPeriod);
      return;
    }

    // Handle numeric reorgPeriod
    this.logger.info(
      { chain: chainName, txHash, confirmations: reorgPeriod },
      'Waiting for reorgPeriod confirmations',
    );

    await provider.waitForTransaction(txHash, reorgPeriod);

    this.logger.info(
      { chain: chainName, txHash },
      'Transaction confirmed at reorgPeriod depth',
    );
  }

  /**
   * Wait for a transaction to be included in a finalized/safe block.
   * Used for chains like Polygon that use string block tags instead of numeric reorgPeriod.
   */
  private async waitForFinalizedBlock(
    chainName: string,
    txHash: string,
    blockTag: string,
  ): Promise<void> {
    const provider = this.multiProvider.getProvider(chainName);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Transaction receipt not found: ${txHash}`);
    }
    const txBlock = receipt.blockNumber;

    this.logger.info(
      { chain: chainName, txHash, txBlock, blockTag },
      'Waiting for transaction to be in finalized block',
    );

    const POLL_INTERVAL_MS = 2000;
    const MAX_WAIT_MS = 60000; // 1 minute timeout
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT_MS) {
      const taggedBlock = await provider.getBlock(blockTag);
      if (taggedBlock && taggedBlock.number >= txBlock) {
        this.logger.info(
          { chain: chainName, txHash, finalizedBlock: taggedBlock.number },
          'Transaction is in finalized block range',
        );
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    this.logger.warn(
      { chain: chainName, txHash, blockTag },
      'Timeout waiting for finalized block, proceeding anyway',
    );
  }
}
