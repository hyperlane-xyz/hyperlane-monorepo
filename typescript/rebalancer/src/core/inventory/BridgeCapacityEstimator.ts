import type { Logger } from 'pino';

import {
  type ChainName,
  type MultiProvider,
  type Token,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../../config/types.js';
import type { IExternalBridge } from '../../interfaces/IExternalBridge.js';
import {
  getExternalBridgeTokenAddress,
  isNativeTokenStandard,
} from '../../utils/tokenUtils.js';
import type { BridgeCapacity } from './types.js';

const GAS_COST_MULTIPLIER = 20n;
const MAX_GAS_PERCENT_THRESHOLD = 10n;

export class BridgeCapacityEstimator {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly getExternalBridge: (
      type: ExternalBridgeType,
    ) => IExternalBridge,
    private readonly getNativeTokenAddress: (
      bridgeType: ExternalBridgeType,
    ) => string,
    private readonly getTokenForChain: (chain: ChainName) => Token | undefined,
    private readonly getInventorySignerAddress: (chain: ChainName) => string,
    private readonly logger: Logger,
  ) {}

  async calculateBridgeCapacity(
    sourceChain: ChainName,
    targetChain: ChainName,
    rawInventory: bigint,
    externalBridgeType: ExternalBridgeType,
  ): Promise<BridgeCapacity> {
    const sourceToken = this.getTokenForChain(sourceChain);
    const targetToken = this.getTokenForChain(targetChain);
    assert(sourceToken, `No token found for source chain: ${sourceChain}`);
    assert(targetToken, `No token found for target chain: ${targetChain}`);

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
}
