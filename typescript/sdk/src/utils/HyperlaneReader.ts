import { BigNumber, errors as EthersError, providers, utils } from 'ethers';
import { LevelWithSilentOrString } from 'pino';

import { MultiProvider } from '../providers/MultiProvider.js';
import {
  BlockchainError,
  HyperlaneSmartProvider,
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
    try {
      // Probe helpers treat deterministic ABI misses/reverts as "not this
      // contract shape" while still surfacing transport/provider failures.
      const result = await this.probeCall(
        {
          ...txOverrides,
          to: address,
          data: contractInterface.encodeFunctionData(method, args),
        },
        blockTag,
      );

      if (result === '0x') {
        return undefined;
      }

      const decoded = contractInterface.decodeFunctionResult(method, result);
      return (decoded.length === 1 ? decoded[0] : decoded) as T;
    } catch (error) {
      if (this.isDeterministicProbeFailure(error)) {
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
      if (this.isDeterministicProbeFailure(error)) {
        return undefined;
      }

      throw error;
    }
  }

  protected isDeterministicProbeFailure(error: unknown): boolean {
    if (error instanceof BlockchainError) {
      return true;
    }

    const code =
      (error as any)?.code ??
      (error as any)?.cause?.code ??
      (error as any)?.error?.cause?.code;

    return [
      EthersError.CALL_EXCEPTION,
      EthersError.INVALID_ARGUMENT,
      EthersError.NOT_IMPLEMENTED,
      EthersError.UNPREDICTABLE_GAS_LIMIT,
      EthersError.UNSUPPORTED_OPERATION,
    ].includes(code);
  }
}
