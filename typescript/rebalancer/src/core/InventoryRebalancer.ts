import type { Logger } from 'pino';

import {
  type ChainName,
  HyperlaneCore,
  type MultiProtocolSignerSignerAccountInfo,
  type MultiProvider,
  ProviderType,
  SealevelCoreAdapter,
  TOKEN_COLLATERALIZED_STANDARDS,
  type WarpTypedTransaction,
  type WarpCore,
  getSignerForChain,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  ensure0x,
  isEVMLike,
} from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../config/types.js';
import type {
  ExternalBridgeRegistry,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import type {
  IInventoryRebalancer,
  InventoryExecutionResult,
  RebalanceCycleContext,
  RebalancerType,
} from '../interfaces/IRebalancer.js';
import type { InventoryRoute } from '../interfaces/IStrategy.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../tracking/types.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';
import { toProtocolTransaction } from '../utils/transactionUtils.js';
import { BridgeCapacityEstimator } from './inventory/BridgeCapacityEstimator.js';
import { InventoryIntentResolver } from './inventory/IntentResolver.js';
import { InventoryMovementExecutor } from './inventory/InventoryMovementExecutor.js';
import { InventoryPlanner } from './inventory/InventoryPlanner.js';
import { TransferRemoteExecutor } from './inventory/TransferRemoteExecutor.js';
import type {
  BridgeQuoteMode,
  InventoryMovementExecutionResult,
} from './inventory/types.js';

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
  private readonly inventoryPlanner: InventoryPlanner;
  private readonly intentResolver: InventoryIntentResolver;
  private readonly bridgeCapacityEstimator: BridgeCapacityEstimator;
  private readonly movementExecutor: InventoryMovementExecutor;
  private readonly transferRemoteExecutor: TransferRemoteExecutor;

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

    this.inventoryPlanner = new InventoryPlanner(
      () => this.inventoryBalances,
      () => this.consumedInventory,
      this.multiProvider,
      this.warpCore,
      this.getTokenForChain.bind(this),
      this.getInventorySignerAddress.bind(this),
      this.logger,
    );
    this.bridgeCapacityEstimator = new BridgeCapacityEstimator(
      this.multiProvider,
      this.getExternalBridge.bind(this),
      this.getNativeTokenAddress.bind(this),
      this.getTokenForChain.bind(this),
      this.getInventorySignerAddress.bind(this),
      this.logger,
    );
    this.movementExecutor = new InventoryMovementExecutor(
      this.config,
      this.actionTracker,
      () => this.consumedInventory,
      this.multiProvider,
      this.getExternalBridge.bind(this),
      this.getNativeTokenAddress.bind(this),
      this.getTokenForChain.bind(this),
      this.getProtocolForChain.bind(this),
      this.getInventorySignerAddress.bind(this),
      this.logger,
    );
    this.transferRemoteExecutor = new TransferRemoteExecutor(
      this.actionTracker,
      this.warpCore,
      this.multiProvider,
      this.getTokenForChain.bind(this),
      this.getInventorySignerAddress.bind(this),
      (chain, typedTx) => this.sendAndConfirmInventoryTx(chain, typedTx),
      (origin, txHash) => this.extractDispatchedMessageId(origin, txHash),
      this.logger,
    );
    this.intentResolver = new InventoryIntentResolver(
      this.actionTracker,
      this.multiProvider,
      this.executeRoute.bind(this),
      this.consumeSuccessfulRoute.bind(this),
      this.logger,
    );

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
   * Execute inventory-based rebalances for the given routes.
   *
   * Single-intent architecture:
   * 1. Check for existing in_progress intent
   * 2. If exists, continue existing intent (ignores new routes)
   * 3. If not, take only the FIRST route and create a single intent
   */
  async rebalance(
    routes: InventoryRoute[],
    context?: RebalanceCycleContext,
  ): Promise<InventoryExecutionResult[]> {
    if (context?.inventoryBalances) {
      this.setInventoryBalances(context.inventoryBalances);
    }

    this.consumedInventory.clear();
    return this.intentResolver.rebalance(routes);
  }

  private consumeSuccessfulRoute(
    route: InventoryRoute,
    result: InventoryExecutionResult,
  ): void {
    if (result.success && result.amountSent) {
      const current = this.consumedInventory.get(route.destination) ?? 0n;
      this.consumedInventory.set(
        route.destination,
        current + result.amountSent,
      );
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

    const plan = await this.inventoryPlanner.buildTransferPlan(route, intent);
    const {
      sourceToken,
      requestedLocalAmount,
      availableInventory,
      maxTransferable,
      minViableTransfer,
      totalCost,
    } = plan;

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
    const swappedRoute = this.inventoryPlanner.buildSwappedRoute(
      route,
      requestedLocalAmount,
    );

    if (maxTransferable >= requestedLocalAmount) {
      // Sufficient inventory on destination - execute transferRemote directly
      const fulfilledCanonicalAmount = this.inventoryPlanner.canonicalAmount(
        requestedLocalAmount,
        sourceToken,
      );
      const result = await this.executeTransferRemote(
        swappedRoute,
        intent,
        fulfilledCanonicalAmount,
      );
      // Return original strategy route in result (not the swapped execution route)
      return { ...result, route };
    } else if (maxTransferable > 0n && maxTransferable >= minViableTransfer) {
      // Partial transfer: Transfer available inventory when economically viable
      const alignedExecution = this.inventoryPlanner.alignLocalToCanonical(
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
        costMultiplier: this.inventoryPlanner
          .minViableCostMultiplier()
          .toString(),
        intentId: intent.id,
      },
      'Inventory below cost-based threshold on destination, triggering LiFi movement',
    );

    // Get all available source chains with raw inventory
    const allSources = this.inventoryPlanner.selectAllSourceChains(destination);

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
      const capacity =
        await this.bridgeCapacityEstimator.calculateBridgeCapacity(
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

    const { bridgePlans, shortfall, targetWithBuffer, totalPlanned } =
      this.inventoryPlanner.buildBridgePlans(
        viableSources,
        requestedLocalAmount,
        availableInventory,
        totalCost,
      );

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
          quoteMode: p.quoteMode,
        })),
        totalPlanned: totalPlanned.toString(),
        shortfall: shortfall.toString(),
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
          plan.quoteMode,
          intent,
          route.externalBridge,
        ),
      ),
    );

    // Process results
    let successCount = 0;
    let totalQuotedOutputMin = 0n;
    const failedErrors: string[] = [];

    for (let i = 0; i < bridgeResults.length; i++) {
      const result = bridgeResults[i];
      const plan = bridgePlans[i];

      if (result.status === 'fulfilled' && result.value.success) {
        successCount++;
        totalQuotedOutputMin += result.value.quotedOutputMin;
        this.logger.info(
          {
            sourceChain: plan.chain,
            plannedTargetOutput: plan.targetOutput.toString(),
            quotedOutput: result.value.quotedOutput.toString(),
            quotedOutputMin: result.value.quotedOutputMin.toString(),
            quoteModeUsed: result.value.quoteModeUsed,
            txHash: result.value.txHash,
          },
          'Inventory movement succeeded',
        );
      } else {
        let error: string | undefined;
        if (result.status === 'rejected') {
          if (result.reason instanceof Error) {
            error = result.reason.message;
          } else if (typeof result.reason === 'string') {
            error = result.reason;
          } else {
            try {
              error = JSON.stringify(result.reason) ?? String(result.reason);
            } catch {
              error = String(result.reason);
            }
          }
        } else if (!result.value.success) {
          error = result.value.error;
        }
        if (error) {
          failedErrors.push(`${plan.chain}: ${error}`);
        }
        this.logger.warn(
          {
            sourceChain: plan.chain,
            plannedTargetOutput: plan.targetOutput.toString(),
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
        totalQuotedOutputMin: totalQuotedOutputMin.toString(),
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
   */
  private async executeTransferRemote(
    route: InventoryRoute,
    intent: RebalanceIntent,
    fulfilledCanonicalAmount: bigint,
  ): Promise<InventoryExecutionResult> {
    return this.transferRemoteExecutor.executeTransferRemote(
      route,
      intent,
      fulfilledCanonicalAmount,
    );
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
      case ProtocolType.Tron:
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

      if (isEVMLike(protocol)) {
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
   * Execute inventory movement from source chain to target chain via LiFi bridge.
   *
   * Quote mode is chosen during planning:
   * - `reverse`: request an exact target-chain output when the source has headroom
   * - `forward`: spend the source cap directly when source inventory is the limiter
   *
   * @param sourceChain - Chain to move inventory from
   * @param targetChain - Chain to move inventory to (origin chain for rebalancing)
   * @param targetOutputAmount - Destination-local amount to receive
   * @param maxSourceInput - Maximum source-local amount available for this plan
   * @param quoteMode - Whether to execute this bridge plan as exact-input or exact-output
   * @param intent - Rebalance intent for tracking
   * @param externalBridgeType - External bridge type to use
   * @returns Result with success status and optional txHash/error
   */
  private async executeInventoryMovement(
    sourceChain: ChainName,
    targetChain: ChainName,
    targetOutputAmount: bigint,
    maxSourceInput: bigint,
    quoteMode: BridgeQuoteMode,
    intent: RebalanceIntent,
    externalBridgeType: ExternalBridgeType,
  ): Promise<InventoryMovementExecutionResult> {
    return this.movementExecutor.executeInventoryMovement(
      sourceChain,
      targetChain,
      targetOutputAmount,
      maxSourceInput,
      quoteMode,
      intent,
      externalBridgeType,
    );
  }
}
