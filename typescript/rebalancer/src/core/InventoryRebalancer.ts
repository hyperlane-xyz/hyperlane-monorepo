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
 * Minimum inventory balance required to execute a partial transferRemote.
 * Below this threshold, trigger LiFi movement instead of a tiny partial transfer.
 * Set to 0.001 ETH (1e15 wei) - below this, transaction costs likely exceed the value.
 */
const MIN_INVENTORY_FOR_TRANSFER = BigInt(1e15); // 0.001 ETH

/**
 * Standard address representation for native ETH in DeFi protocols (including LiFi).
 * This is the common convention used by bridges and DEXes to represent native gas tokens.
 */
const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Percentage of available inventory to use for LiFi bridge.
 * Reserve the remaining portion for gas costs.
 * Set to 95% (reserve 5% for gas) - this provides a comfortable buffer
 * for gas price fluctuations while maximizing bridge transfer amounts.
 */
const BRIDGE_AMOUNT_PERCENTAGE = 95n;

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
   * Calculate the maximum transferable amount after reserving IGP and gas costs.
   * For native tokens, both IGP and transaction gas must be paid from the same balance.
   *
   * @param originChain - Chain to transfer from
   * @param destinationChain - Chain to transfer to
   * @param availableInventory - Available token balance on origin chain
   * @param requestedAmount - Requested transfer amount
   * @returns Maximum amount that can be transferred after reserving costs
   */
  private async calculateMaxTransferable(
    originChain: ChainName,
    destinationChain: ChainName,
    availableInventory: bigint,
    requestedAmount: bigint,
  ): Promise<bigint> {
    const originToken = this.getTokenForChain(originChain);
    if (!originToken) {
      throw new Error(`No token found for origin chain: ${originChain}`);
    }

    // For non-native tokens, no IGP/gas reservation needed from token balance
    if (!this.isNativeTokenStandard(originToken.standard)) {
      return availableInventory < requestedAmount
        ? availableInventory
        : requestedAmount;
    }

    // For native tokens, we need to reserve funds for IGP AND transaction gas
    const destinationDomain = this.multiProvider.getDomainId(destinationChain);
    const adapter = originToken.getHypAdapter(this.warpCore.multiProvider);

    // Quote IGP for the requested amount (IGP cost doesn't vary significantly with amount)
    const gasQuote = await adapter.quoteTransferRemoteGas({
      destination: destinationDomain,
      sender: this.config.inventorySigner,
      recipient: this.config.inventorySigner,
      amount: requestedAmount,
    });

    const igpCost = gasQuote.igpQuote.amount;

    // Estimate transaction gas cost (gas price × estimated gas limit)
    // Use a generous estimate for transferRemote: ~300,000 gas
    const estimatedGasLimit = 300_000n;
    const provider = this.multiProvider.getProvider(originChain);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const estimatedGasCost = BigInt(gasPrice.toString()) * estimatedGasLimit;

    // Total reservation = IGP + transaction gas
    const totalReservation = igpCost + estimatedGasCost;

    this.logger.debug(
      {
        originChain,
        destinationChain,
        availableInventory: availableInventory.toString(),
        requestedAmount: requestedAmount.toString(),
        igpCost: igpCost.toString(),
        estimatedGasCost: estimatedGasCost.toString(),
        totalReservation: totalReservation.toString(),
        tokenStandard: originToken.standard,
      },
      'Calculating max transferable for native token',
    );

    // Reserve total costs from available inventory
    if (availableInventory <= totalReservation) {
      this.logger.warn(
        {
          originChain,
          availableInventory: availableInventory.toString(),
          igpCost: igpCost.toString(),
          estimatedGasCost: estimatedGasCost.toString(),
          totalReservation: totalReservation.toString(),
        },
        'Insufficient inventory to cover IGP and gas costs',
      );
      return 0n;
    }

    const maxAfterReservation = availableInventory - totalReservation;
    return maxAfterReservation < requestedAmount
      ? maxAfterReservation
      : requestedAmount;
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

    this.logger.debug(
      {
        checkingChain: destination,
        availableInventory: availableInventory.toString(),
        requiredAmount: amount.toString(),
      },
      'Checking effective inventory on destination (deficit) chain',
    );

    // Calculate max transferable after reserving IGP costs for native tokens
    // transferRemote is called FROM destination TO origin (swapped direction)
    const maxTransferable = await this.calculateMaxTransferable(
      destination, // FROM chain (where transferRemote is called)
      origin, // TO chain (where Hyperlane message goes)
      availableInventory,
      amount,
    );

    this.logger.debug(
      {
        fromChain: destination,
        toChain: origin,
        availableInventory: availableInventory.toString(),
        requestedAmount: amount.toString(),
        maxTransferable: maxTransferable.toString(),
      },
      'Calculated max transferable amount',
    );

    // Swap the route for executeTransferRemote: destination → origin
    // This ensures transferRemote is called FROM destination, ADDING collateral there
    const swappedRoute: InventoryRoute = {
      origin: destination, // transferRemote called FROM here
      destination: origin, // Hyperlane message goes TO here
      amount,
    };

    if (maxTransferable >= amount) {
      // Sufficient inventory on destination - execute transferRemote directly
      const result = await this.executeTransferRemote(swappedRoute, intent);
      // Return original strategy route in result (not the swapped execution route)
      return { ...result, route };
    } else if (maxTransferable >= MIN_INVENTORY_FOR_TRANSFER) {
      // Partial inventory available above threshold - execute what we can (after IGP reservation)
      const partialSwappedRoute = { ...swappedRoute, amount: maxTransferable };
      const result = await this.executeTransferRemote(
        partialSwappedRoute,
        intent,
      );

      // Note: The intent remains in_progress since it's not fully fulfilled
      // The remaining amount will be handled in future cycles once more inventory is available
      this.logger.info(
        {
          intentId: intent.id,
          partialAmount: maxTransferable.toString(),
          remainingAmount: (amount - maxTransferable).toString(),
        },
        'Executed partial inventory deposit, remaining will be handled in future cycles',
      );

      // Return original strategy route in result (not the swapped execution route)
      return { ...result, route };
    } else {
      // Inventory below threshold or zero - trigger LiFi movement TO destination chain
      this.logger.info(
        {
          targetChain: destination,
          maxTransferable: maxTransferable.toString(),
          threshold: MIN_INVENTORY_FOR_TRANSFER.toString(),
          intentId: intent.id,
        },
        'Inventory below threshold on destination, triggering LiFi movement',
      );

      // Find source chain to bridge FROM (to destination)
      const sourceInfo = await this.selectSourceChain(destination, amount);

      if (!sourceInfo) {
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

      // Determine amount to move (limited by available inventory)
      const moveAmount =
        amount > sourceInfo.availableAmount
          ? sourceInfo.availableAmount
          : amount;

      // Execute inventory movement from source chain TO destination chain
      // (destination is where we need inventory to call transferRemote FROM)
      const movementResult = await this.executeInventoryMovement(
        sourceInfo.chain,
        destination, // Bridge TO destination (deficit chain)
        moveAmount,
        intent,
      );

      if (!movementResult.success) {
        return {
          route,
          intent,
          success: false,
          error: `Inventory movement failed: ${movementResult.error}`,
        };
      }

      // Note: The actual transferRemote will happen in a future cycle
      // after the inventory_movement completes and inventory is available on destination
      this.logger.info(
        {
          sourceChain: sourceInfo.chain,
          targetChain: destination,
          strategyOrigin: origin,
          amount: moveAmount.toString(),
          intentId: intent.id,
          txHash: movementResult.txHash,
        },
        'Inventory movement initiated, transferRemote will execute after bridge completes',
      );

      return {
        route,
        intent,
        success: true,
      };
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
   */
  private async executeTransferRemote(
    route: InventoryRoute,
    intent: RebalanceIntent,
  ): Promise<InventoryExecutionResult> {
    const { origin, destination, amount } = route;

    const originToken = this.getTokenForChain(origin);
    if (!originToken) {
      throw new Error(`No token found for origin chain: ${origin}`);
    }

    const destinationDomain = this.multiProvider.getDomainId(destination);

    // Get the hyperlane adapter for the token
    // Use warpCore.multiProvider which is a MultiProtocolProvider
    const adapter = originToken.getHypAdapter(this.warpCore.multiProvider);

    // Quote the transfer remote gas
    const gasQuote = await adapter.quoteTransferRemoteGas({
      destination: destinationDomain,
      sender: this.config.inventorySigner,
      recipient: this.config.inventorySigner,
      amount,
    });

    this.logger.debug(
      {
        origin,
        destination,
        amount: amount.toString(),
        gasQuote: {
          igpQuote: gasQuote.igpQuote.amount.toString(),
        },
      },
      'Quoted transferRemote gas',
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
   * Select the best source chain for inventory movement.
   * Prefers a chain with sufficient balance, otherwise returns the chain with highest available.
   *
   * @param targetChain - Chain that needs inventory
   * @param requiredAmount - Amount needed
   * @returns Source chain info or null if no inventory available anywhere
   */
  private async selectSourceChain(
    targetChain: ChainName,
    requiredAmount: bigint,
  ): Promise<{ chain: ChainName; availableAmount: bigint } | null> {
    const balances = await this.inventoryMonitor.getBalances();
    let bestSource: { chain: ChainName; availableAmount: bigint } | null = null;

    for (const [chainName, balance] of balances) {
      // Skip the target chain itself
      if (chainName === targetChain) continue;

      // Calculate effective available inventory accounting for consumed amounts
      const consumed = this.consumedInventory.get(chainName) ?? 0n;
      const effectiveAvailable =
        balance.available > consumed ? balance.available - consumed : 0n;

      // If this chain has sufficient effective balance, use it immediately
      if (effectiveAvailable >= requiredAmount) {
        this.logger.debug(
          {
            sourceChain: chainName,
            targetChain,
            cachedBalance: balance.available.toString(),
            consumed: consumed.toString(),
            effectiveAvailable: effectiveAvailable.toString(),
            required: requiredAmount.toString(),
          },
          'Found source chain with sufficient effective inventory',
        );
        return { chain: chainName, availableAmount: effectiveAvailable };
      }

      // Track the chain with highest effective balance as fallback
      if (!bestSource || effectiveAvailable > bestSource.availableAmount) {
        bestSource = { chain: chainName, availableAmount: effectiveAvailable };
      }
    }

    // Return best source if it has any effective balance
    if (bestSource && bestSource.availableAmount > 0n) {
      this.logger.debug(
        {
          sourceChain: bestSource.chain,
          targetChain,
          effectiveAvailable: bestSource.availableAmount.toString(),
          required: requiredAmount.toString(),
        },
        'Selected source chain with partial effective inventory',
      );
      return bestSource;
    }

    return null;
  }

  /**
   * Execute inventory movement from source chain to target chain via LiFi bridge.
   *
   * @param sourceChain - Chain to move inventory from
   * @param targetChain - Chain to move inventory to (origin chain for rebalancing)
   * @param amount - Amount to move
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
    // and reserve 5% for gas costs
    const availableInventory =
      await this.getEffectiveAvailableInventory(sourceChain);
    const maxBridgeable =
      (availableInventory * BRIDGE_AMOUNT_PERCENTAGE) / 100n;
    const bridgeAmount = amount > maxBridgeable ? maxBridgeable : amount;

    if (bridgeAmount === 0n) {
      return {
        success: false,
        error: `Insufficient inventory on ${sourceChain} after gas reservation`,
      };
    }

    const gasReserved = availableInventory - bridgeAmount;

    this.logger.info(
      {
        sourceChain,
        targetChain,
        sourceChainId,
        targetChainId,
        requestedAmount: amount.toString(),
        availableInventory: availableInventory.toString(),
        bridgeAmount: bridgeAmount.toString(),
        gasReserved: gasReserved.toString(),
        intentId: intent.id,
      },
      'Executing inventory movement via LiFi (reserving 5% for gas)',
    );

    try {
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

      // Quote the bridge with reduced amount (95% of available)
      const quote = await this._bridge.quote({
        fromChain: sourceChainId,
        toChain: targetChainId,
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        fromAmount: bridgeAmount,
        fromAddress: this.config.inventorySigner,
        toAddress: this.config.inventorySigner,
      });

      this.logger.debug(
        {
          quoteId: quote.id,
          tool: quote.tool,
          toAmount: quote.toAmount.toString(),
          executionDuration: quote.executionDuration,
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
      await this.actionTracker.createRebalanceAction({
        intentId: intent.id,
        origin: this.multiProvider.getDomainId(sourceChain),
        destination: this.multiProvider.getDomainId(targetChain),
        amount: bridgeAmount,
        type: 'inventory_movement',
        txHash: result.txHash,
      });

      // Track consumed inventory on source chain for this cycle
      const currentConsumed = this.consumedInventory.get(sourceChain) ?? 0n;
      this.consumedInventory.set(sourceChain, currentConsumed + bridgeAmount);

      this.logger.debug(
        {
          sourceChain,
          amountConsumed: bridgeAmount.toString(),
          totalConsumed: (currentConsumed + bridgeAmount).toString(),
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
