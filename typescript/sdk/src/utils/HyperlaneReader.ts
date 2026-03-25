import { BigNumber, errors as EthersError, providers, utils } from 'ethers';
import { LevelWithSilentOrString } from 'pino';

import { MultiProvider } from '../providers/MultiProvider.js';
import {
  HyperlaneSmartProvider,
  ProbeMissError,
  isDeterministicCallException,
} from '../providers/SmartProvider/SmartProvider.js';
import { ChainNameOrId } from '../types.js';

export class HyperlaneReader {
  provider: providers.Provider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
  }

  /**
   * Conditionally sets the log level for a smart provider.
   *
   * @param level - The log level to set, e.g. 'debug', 'info', 'warn', 'error'.
   */
  protected setSmartProviderLogLevel(level: LevelWithSilentOrString): void {
    if (this.provider instanceof HyperlaneSmartProvider) {
      this.provider.setLogLevel(level);
    }
  }

  protected async probeCall(
    transaction: providers.TransactionRequest,
    blockTag: providers.BlockTag = 'latest',
  ): Promise<string> {
    if (this.provider instanceof HyperlaneSmartProvider) {
      return this.provider.probeCall(transaction, blockTag);
    }

    return this.provider.call(transaction, blockTag);
  }

  protected async probeEstimateGas(
    transaction: providers.TransactionRequest,
  ): Promise<BigNumber> {
    if (this.provider instanceof HyperlaneSmartProvider) {
      return this.provider.probeEstimateGas(transaction);
    }

    return this.provider.estimateGas(transaction);
  }

  protected async probeContractCall<T>(
    address: string,
    contractInterface: utils.Interface,
    method: string,
    args: unknown[] = [],
    txOverrides: providers.TransactionRequest = {},
    blockTag: providers.BlockTag = 'latest',
  ): Promise<T | undefined> {
    let result: string;

    try {
      result = await this.probeCall(
        {
          ...txOverrides,
          to: address,
          data: contractInterface.encodeFunctionData(method, args),
        },
        blockTag,
      );
    } catch (error) {
      if (this.isProbeMissError(error)) {
        return undefined;
      }

      throw error;
    }

    if (result === '0x') {
      return undefined;
    }

    try {
      const decoded = contractInterface.decodeFunctionResult(method, result);
      return (decoded.length === 1 ? decoded[0] : decoded) as T;
    } catch (error) {
      if ((error as any)?.code === EthersError.INVALID_ARGUMENT) {
        return undefined;
      }

      throw error;
    }
  }

  protected async probeContractEstimateGas(
    transaction: providers.TransactionRequest,
  ): Promise<BigNumber | undefined> {
    try {
      return await this.probeEstimateGas(transaction);
    } catch (error) {
      if (this.isProbeMissError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  protected isProbeMissError(error: unknown): boolean {
    if (error instanceof ProbeMissError) {
      return true;
    }

    const code =
      (error as any)?.code ??
      (error as any)?.cause?.code ??
      (error as any)?.error?.cause?.code;

    if (code === EthersError.UNPREDICTABLE_GAS_LIMIT) {
      return true;
    }

    if (code !== EthersError.CALL_EXCEPTION) {
      return false;
    }

    const callException =
      (error as any)?.code === EthersError.CALL_EXCEPTION
        ? error
        : (error as any)?.cause?.code === EthersError.CALL_EXCEPTION
          ? (error as any).cause
          : (error as any)?.error?.cause;

    return isDeterministicCallException(callException);
  }
}
