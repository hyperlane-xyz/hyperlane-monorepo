import type { Logger } from 'pino';

import {
  type ChainName,
  type MultiProvider,
  type Token,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, fromWei } from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../../config/types.js';
import type { InventoryRebalancerConfig } from '../InventoryRebalancer.js';
import type { IExternalBridge } from '../../interfaces/IExternalBridge.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../../tracking/types.js';
import { getExternalBridgeTokenAddress } from '../../utils/tokenUtils.js';
import type {
  BridgeQuoteMode,
  InventoryMovementExecutionResult,
} from './types.js';

export class InventoryMovementExecutor {
  constructor(
    private readonly config: InventoryRebalancerConfig,
    private readonly actionTracker: IActionTracker,
    private readonly consumedInventory: () => Map<ChainName, bigint>,
    private readonly multiProvider: MultiProvider,
    private readonly getExternalBridge: (
      type: ExternalBridgeType,
    ) => IExternalBridge,
    private readonly getNativeTokenAddress: (
      bridgeType: ExternalBridgeType,
    ) => string,
    private readonly getTokenForChain: (chain: ChainName) => Token | undefined,
    private readonly getProtocolForChain: (chain: ChainName) => ProtocolType,
    private readonly getInventorySignerAddress: (chain: ChainName) => string,
    private readonly logger: Logger,
  ) {}

  async executeInventoryMovement(
    sourceChain: ChainName,
    targetChain: ChainName,
    targetOutputAmount: bigint,
    maxSourceInput: bigint,
    quoteMode: BridgeQuoteMode,
    intent: RebalanceIntent,
    externalBridgeType: ExternalBridgeType,
  ): Promise<InventoryMovementExecutionResult> {
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

    const sourceChainId = Number(this.multiProvider.getChainId(sourceChain));
    const targetChainId = Number(this.multiProvider.getChainId(targetChain));
    const fromTokenAddress = getExternalBridgeTokenAddress(
      sourceToken,
      externalBridgeType,
      this.getNativeTokenAddress,
    );
    const toTokenAddress = getExternalBridgeTokenAddress(
      targetToken,
      externalBridgeType,
      this.getNativeTokenAddress,
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
      const fromAddress = this.getInventorySignerAddress(sourceChain);
      const toAddress = this.getInventorySignerAddress(targetChain);
      const quoteWithMode = async (mode: BridgeQuoteMode) =>
        externalBridge.quote({
          fromChain: sourceChainId,
          toChain: targetChainId,
          fromToken: fromTokenAddress,
          toToken: toTokenAddress,
          ...(mode === 'forward'
            ? { fromAmount: maxSourceInput }
            : { toAmount: targetOutputAmount }),
          fromAddress,
          toAddress,
        });

      let quoteModeUsed = quoteMode;
      let quote = await quoteWithMode(quoteModeUsed);

      if (quoteModeUsed === 'reverse' && quote.fromAmount > maxSourceInput) {
        this.logger.warn(
          {
            sourceChain,
            targetChain,
            plannedQuoteMode: quoteMode,
            requestedTargetOutput: targetOutputAmount.toString(),
            quotedInput: quote.fromAmount.toString(),
            maxSourceInput: maxSourceInput.toString(),
            intentId: intent.id,
          },
          'Reverse bridge quote exceeded source capacity, retrying with forward quote',
        );

        quoteModeUsed = 'forward';
        quote = await quoteWithMode(quoteModeUsed);
      }

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
          quoteModePlanned: quoteMode,
          quoteModeUsed,
          retriedAsForward:
            quoteMode === 'reverse' && quoteModeUsed === 'forward',
          inputRequired: inputRequired.toString(),
          inputRequiredFormatted: this.formatLocalAmount(
            inputRequired,
            sourceToken,
          ),
          quotedOutput: quote.toAmount.toString(),
          quotedOutputMin: quote.toAmountMin.toString(),
          quotedOutputFormatted: this.formatLocalAmount(
            quote.toAmount,
            targetToken,
          ),
          quotedOutputMinFormatted: this.formatLocalAmount(
            quote.toAmountMin,
            targetToken,
          ),
          gasCosts: quote.gasCosts.toString(),
          feeCosts: quote.feeCosts.toString(),
          intentId: intent.id,
        },
        'Executing inventory movement via bridge quote',
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

      await this.actionTracker.createRebalanceAction({
        intentId: intent.id,
        origin: this.multiProvider.getDomainId(sourceChain),
        destination: this.multiProvider.getDomainId(targetChain),
        amount: inputRequired,
        type: 'inventory_movement',
        txHash: result.txHash,
        externalBridgeId: externalBridgeType,
      });

      const currentConsumed = this.consumedInventory().get(sourceChain) ?? 0n;
      this.consumedInventory().set(
        sourceChain,
        currentConsumed + inputRequired,
      );

      this.logger.debug(
        {
          sourceChain,
          amountConsumed: inputRequired.toString(),
          totalConsumed: (currentConsumed + inputRequired).toString(),
        },
        'Updated consumed inventory after LiFi bridge',
      );

      return {
        success: true,
        txHash: result.txHash,
        inputRequired,
        quotedOutput: quote.toAmount,
        quotedOutputMin: quote.toAmountMin,
        quoteModeUsed,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          sourceChain,
          targetChain,
          amount: targetOutputAmount.toString(),
          intentId: intent.id,
          error: errorMessage,
        },
        'Failed to execute inventory movement',
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private formatLocalAmount(amount: bigint, token: Token): string {
    return fromWei(amount.toString(), token.decimals);
  }
}
