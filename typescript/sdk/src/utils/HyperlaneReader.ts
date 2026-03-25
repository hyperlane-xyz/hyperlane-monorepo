import { BigNumber, errors as EthersError, providers, utils } from 'ethers';
import { LevelWithSilentOrString } from 'pino';

import { MultiProvider } from '../providers/MultiProvider.js';
import {
  HyperlaneSmartProvider,
  ProbeMissError,
  isDeterministicCallException,
} from '../providers/SmartProvider/SmartProvider.js';
import { ChainNameOrId } from '../types.js';

type NestedError = {
  cause?: unknown;
  error?: unknown;
};

function getNestedErrorWithCode(
  error: unknown,
  code: string,
): { code: string } | undefined {
  const queue: unknown[] = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate == null || typeof candidate !== 'object') {
      continue;
    }
    if (visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);

    if (
      'code' in candidate &&
      (candidate as { code?: unknown }).code === code
    ) {
      return candidate as { code: string };
    }

    const nested = candidate as NestedError;
    queue.push(nested.cause, nested.error);
  }

  return undefined;
}

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
    const txReq = {
      ...transaction,
      ...this.multiProvider.getTransactionOverrides(this.chain),
    };
    if (this.provider instanceof HyperlaneSmartProvider) {
      return this.provider.probeCall(txReq, blockTag);
    }

    return this.provider.call(txReq, blockTag);
  }

  protected async probeEstimateGas(
    transaction: providers.TransactionRequest,
  ): Promise<BigNumber> {
    const txReq = {
      ...transaction,
      ...this.multiProvider.getTransactionOverrides(this.chain),
    };
    if (this.provider instanceof HyperlaneSmartProvider) {
      return this.provider.probeEstimateGas(txReq);
    }

    return this.provider.estimateGas(txReq);
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
      if (
        getNestedErrorWithCode(error, EthersError.INVALID_ARGUMENT) ||
        this.isProbeMissError(error)
      ) {
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

    if (getNestedErrorWithCode(error, EthersError.UNPREDICTABLE_GAS_LIMIT)) {
      return true;
    }

    const callException = getNestedErrorWithCode(
      error,
      EthersError.CALL_EXCEPTION,
    );
    if (!callException) {
      return false;
    }

    return isDeterministicCallException(callException);
  }
}
