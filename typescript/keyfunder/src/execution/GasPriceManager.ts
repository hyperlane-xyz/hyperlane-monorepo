import { ethers } from 'ethers';
import { GasFeeEstimates } from '../types';

export class GasPriceManager {
  private defaultPriorityFee: bigint = ethers.parseUnits('1.5', 'gwei'); // 1.5 Gwei default
  private defaultGasLimit: bigint = 21000n; // Basic transfer
  private defaultBufferMultiplier: number;

  constructor(defaultBufferMultiplier: number = 1.2) {
    this.defaultBufferMultiplier = defaultBufferMultiplier;
  }

  /**
   * Calculate current fee estimates for EVM transactions
   */
  public async getFeeEstimates(
    provider: ethers.Provider,
    bufferMultiplier?: number,
    gasLimit?: bigint
  ): Promise<GasFeeEstimates> {
    const feeData = await provider.getFeeData();
    const effectiveMultiplier = bufferMultiplier ?? this.defaultBufferMultiplier;
    const multiplierBps = BigInt(Math.round(effectiveMultiplier * 100));

    const resolvedGasLimit = gasLimit ?? this.defaultGasLimit;

    // Check if network supports EIP-1559
    if (feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null) {
      let priorityFee = feeData.maxPriorityFeePerGas;
      if (priorityFee < this.defaultPriorityFee) {
        priorityFee = this.defaultPriorityFee;
      }
      // Apply buffer to priority fee
      priorityFee = (priorityFee * multiplierBps) / 100n;

      let maxFee = feeData.maxFeePerGas;
      maxFee = (maxFee * multiplierBps) / 100n;

      // Ensure maxFee is at least priorityFee
      if (maxFee < priorityFee) {
        maxFee = priorityFee * 2n;
      }

      return {
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
        gasLimit: resolvedGasLimit,
      };
    }

    // Fallback to legacy gasPrice
    let gasPrice = feeData.gasPrice ?? ethers.parseUnits('20', 'gwei');
    gasPrice = (gasPrice * multiplierBps) / 100n;

    return {
      gasPrice,
      gasLimit: resolvedGasLimit,
    };
  }

  /**
   * Bump fee estimates by a percentage (default 20%) for transaction replacement / retry
   */
  public bumpFeeEstimates(
    currentFee: GasFeeEstimates,
    bumpPercentage: number = 20
  ): GasFeeEstimates {
    const bumpMultiplierBps = BigInt(100 + bumpPercentage);

    const bumped: GasFeeEstimates = {
      gasLimit: currentFee.gasLimit,
    };

    if (currentFee.maxFeePerGas !== undefined && currentFee.maxPriorityFeePerGas !== undefined) {
      bumped.maxPriorityFeePerGas =
        (currentFee.maxPriorityFeePerGas * bumpMultiplierBps) / 100n;
      bumped.maxFeePerGas =
        (currentFee.maxFeePerGas * bumpMultiplierBps) / 100n;

      // Ensure bumped maxFeePerGas is strictly higher than maxPriorityFeePerGas
      if (bumped.maxFeePerGas <= bumped.maxPriorityFeePerGas) {
        bumped.maxFeePerGas = bumped.maxPriorityFeePerGas * 2n;
      }
    }

    if (currentFee.gasPrice !== undefined) {
      bumped.gasPrice = (currentFee.gasPrice * bumpMultiplierBps) / 100n;
    }

    return bumped;
  }

  /**
   * Estimate gas with buffer multiplier
   */
  public async estimateGasWithBuffer(
    provider: ethers.Provider,
    tx: ethers.TransactionRequest,
    bufferMultiplier?: number
  ): Promise<bigint> {
    try {
      const estimated = await provider.estimateGas(tx);
      const effectiveMultiplier = bufferMultiplier ?? this.defaultBufferMultiplier;
      const multiplierBps = BigInt(Math.round(effectiveMultiplier * 100));
      return (estimated * multiplierBps) / 100n;
    } catch {
      // Return default if estimation fails
      return this.defaultGasLimit;
    }
  }
}
