import type { Logger } from 'pino';

import {
  type ChainName,
  type MultiProvider,
  type Token,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { assert, fromWei } from '@hyperlane-xyz/utils';

import type { InventoryRoute } from '../../interfaces/IStrategy.js';
import type { RebalanceIntent } from '../../tracking/types.js';
import {
  alignLocalToCanonical,
  denormalizeToLocal,
  normalizeToCanonical,
} from '../../utils/balanceUtils.js';
import {
  MIN_VIABLE_COST_MULTIPLIER,
  calculateTransferCosts,
} from '../../utils/gasEstimation.js';
import { isNativeTokenStandard } from '../../utils/tokenUtils.js';
import type {
  BridgeCapacity,
  BridgePlan,
  InventorySource,
  InventoryTransferPlan,
} from './types.js';

const BRIDGE_BUFFER_PERCENT = 5n;

const RECOVERABLE_MAX_TRANSFER_ERROR_MESSAGES = [
  'balance may be insufficient',
  'transfer amount exceeds balance',
  'insufficient balance',
];

function hasRecoverableMaxTransferErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('unpredictable_gas_limit') ||
    RECOVERABLE_MAX_TRANSFER_ERROR_MESSAGES.some((pattern) =>
      normalized.includes(pattern),
    )
  );
}

export function isRecoverableMaxTransferProbeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) continue;

    if (typeof current === 'string') {
      if (hasRecoverableMaxTransferErrorMessage(current)) return true;
      continue;
    }

    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      error?: unknown;
    };

    if (
      typeof candidate.code === 'string' &&
      candidate.code.toUpperCase() === 'UNPREDICTABLE_GAS_LIMIT'
    ) {
      return true;
    }

    if (
      typeof candidate.message === 'string' &&
      hasRecoverableMaxTransferErrorMessage(candidate.message)
    ) {
      return true;
    }

    stack.push(candidate.cause, candidate.error);
  }

  return false;
}

export class InventoryPlanner {
  constructor(
    private readonly inventoryBalances: () => Map<ChainName, bigint>,
    private readonly consumedInventory: () => Map<ChainName, bigint>,
    private readonly multiProvider: MultiProvider,
    private readonly warpCore: WarpCore,
    private readonly getTokenForChain: (chain: ChainName) => Token | undefined,
    private readonly getInventorySignerAddress: (chain: ChainName) => string,
    private readonly logger: Logger,
  ) {}

  getAvailableInventory(chain: ChainName): bigint {
    return this.inventoryBalances().get(chain) ?? 0n;
  }

  getTotalInventory(excludeChains: ChainName[]): bigint {
    const excludeSet = new Set(excludeChains);
    let total = 0n;
    for (const [chain, balance] of this.inventoryBalances()) {
      if (!excludeSet.has(chain)) {
        total += balance;
      }
    }
    return total;
  }

  getEffectiveAvailableInventory(chain: ChainName): bigint {
    const cached = this.getAvailableInventory(chain);
    const consumed = this.consumedInventory().get(chain) ?? 0n;
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

  selectAllSourceChains(targetChain: ChainName): InventorySource[] {
    const sources: InventorySource[] = [];

    for (const [chainName, balance] of this.inventoryBalances()) {
      if (chainName === targetChain) continue;

      const consumed = this.consumedInventory().get(chainName) ?? 0n;
      const effectiveAvailable = balance > consumed ? balance - consumed : 0n;

      if (effectiveAvailable > 0n) {
        sources.push({
          chain: chainName,
          availableAmount: effectiveAvailable,
        });
      }
    }

    return sources.sort((a, b) =>
      a.availableAmount > b.availableAmount ? -1 : 1,
    );
  }

  async buildTransferPlan(
    route: InventoryRoute,
    intent: RebalanceIntent,
  ): Promise<InventoryTransferPlan> {
    const { origin, destination, amount } = route;
    const sourceToken = this.getTokenForChain(destination);
    assert(sourceToken, `No token found for source chain: ${destination}`);
    const requestedLocalAmount = denormalizeToLocal(amount, sourceToken);
    const executionSender = this.getInventorySignerAddress(destination);
    const executionRecipient = this.getInventorySignerAddress(origin);
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

    const costs = await calculateTransferCosts(
      destination,
      origin,
      availableInventory,
      requestedLocalAmount,
      this.multiProvider,
      this.warpCore.multiProvider,
      this.getTokenForChain,
      executionSender,
      isNativeTokenStandard,
      this.logger,
    );
    const { minViableTransfer } = costs;
    let maxTransferable = costs.maxTransferable;

    if (!isNativeTokenStandard(sourceToken.standard)) {
      if (availableInventory === 0n) {
        maxTransferable = 0n;
        this.logger.debug(
          {
            fromChain: destination,
            toChain: origin,
            requestedAmount: requestedLocalAmount.toString(),
          },
          'Skipping fee-aware max transferable probe because destination inventory is zero',
        );
      } else {
        try {
          const feeAwareMaxTransfer = await this.warpCore.getMaxTransferAmount({
            balance: sourceToken.amount(availableInventory),
            destination: origin,
            sender: executionSender,
            recipient: executionRecipient,
          });

          maxTransferable =
            feeAwareMaxTransfer.amount < requestedLocalAmount
              ? feeAwareMaxTransfer.amount
              : requestedLocalAmount;

          this.logger.debug(
            {
              fromChain: destination,
              toChain: origin,
              availableInventory: availableInventory.toString(),
              requestedAmount: requestedLocalAmount.toString(),
              feeAwareMaxTransferable: maxTransferable.toString(),
            },
            'Calculated fee-aware max transferable amount for non-native route',
          );
        } catch (error) {
          if (!isRecoverableMaxTransferProbeError(error)) {
            throw error;
          }

          maxTransferable = 0n;
          this.logger.warn(
            {
              fromChain: destination,
              toChain: origin,
              availableInventory: availableInventory.toString(),
              requestedAmount: requestedLocalAmount.toString(),
              error: error instanceof Error ? error.message : String(error),
              intentId: intent.id,
            },
            'Fee-aware max transferable probe failed due to insufficient balance, falling back to external bridge',
          );
        }
      }
    }

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

    return {
      sourceToken,
      requestedLocalAmount,
      availableInventory,
      maxTransferable,
      minViableTransfer,
      totalCost: costs.totalCost,
      totalInventory,
    };
  }

  buildSwappedRoute(
    route: InventoryRoute,
    requestedLocalAmount: bigint,
  ): InventoryRoute {
    return {
      ...route,
      origin: route.destination,
      destination: route.origin,
      amount: requestedLocalAmount,
    };
  }

  canonicalAmount(localAmount: bigint, token: Token): bigint {
    return normalizeToCanonical(localAmount, token);
  }

  alignLocalToCanonical(localAmount: bigint, token: Token) {
    return alignLocalToCanonical(localAmount, token);
  }

  buildBridgePlans(
    capacities: Array<{ chain: ChainName } & BridgeCapacity>,
    requestedLocalAmount: bigint,
    availableInventory: bigint,
    totalCost: bigint,
  ): {
    bridgePlans: BridgePlan[];
    shortfall: bigint;
    targetWithBuffer: bigint;
    totalPlanned: bigint;
  } {
    const shortfall =
      requestedLocalAmount > availableInventory
        ? requestedLocalAmount - availableInventory
        : 0n;
    const targetWithBuffer =
      ((shortfall + totalCost) * (100n + BRIDGE_BUFFER_PERCENT)) / 100n;
    const bridgePlans: BridgePlan[] = [];
    let totalPlanned = 0n;

    for (const source of capacities) {
      if (totalPlanned >= targetWithBuffer) break;

      const remaining = targetWithBuffer - totalPlanned;
      const targetOutput =
        source.maxTargetOutput >= remaining
          ? remaining
          : source.maxTargetOutput;
      const quoteMode =
        source.maxTargetOutput > remaining ? 'reverse' : 'forward';

      bridgePlans.push({
        chain: source.chain,
        maxSourceInput: source.maxSourceInput,
        targetOutput,
        quoteMode,
      });
      totalPlanned += targetOutput;
    }

    return { bridgePlans, shortfall, targetWithBuffer, totalPlanned };
  }

  minViableCostMultiplier(): bigint {
    return MIN_VIABLE_COST_MULTIPLIER;
  }

  private formatLocalAmount(amount: bigint, token: Token): string {
    return fromWei(amount.toString(), token.decimals);
  }
}
