import { BigNumber, errors as EthersError, providers, utils } from 'ethers';
import { LevelWithSilentOrString } from 'pino';

import { MultiProvider } from '../providers/MultiProvider.js';
import {
  HyperlaneSmartProvider,
  ProbeMissError,
  isDeterministicCallException,
} from '../providers/SmartProvider/SmartProvider.js';
import { ChainNameOrId } from '../types.js';
import {
  MULTICALL3_ADDRESS,
  MULTICALL3_INTERFACE,
  ReadContractCall,
  normalizeDecodedResult,
  readContractsWithMulticall,
  supportsMulticall,
} from './multicall.js';

export class HyperlaneReader {
  provider: providers.Provider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
  }

  private getBatchContractAddress(): string | undefined {
    return this.multiProvider.getChainMetadata(this.chain).batchContractAddress;
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
      if (
        (error as any)?.code === EthersError.INVALID_ARGUMENT ||
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

  protected async readContractBatch<T>(
    calls: ReadContractCall<T>[],
    blockTag: providers.BlockTag = 'latest',
  ): Promise<T[]> {
    return readContractsWithMulticall(
      this.provider,
      calls,
      blockTag,
      this.getBatchContractAddress(),
    );
  }

  protected async tryProbeContractBatch<T>(
    calls: ReadContractCall<T>[],
    blockTag: providers.BlockTag = 'latest',
  ): Promise<Array<T | undefined> | undefined> {
    if (!calls.length) {
      return [];
    }

    const batchContractAddress = this.getBatchContractAddress();
    if (!(await supportsMulticall(this.provider, batchContractAddress))) {
      return undefined;
    }

    let results: Array<{ success: boolean; returnData: string }>;
    try {
      const response = await this.probeCall(
        {
          to: batchContractAddress ?? MULTICALL3_ADDRESS,
          data: MULTICALL3_INTERFACE.encodeFunctionData('aggregate3', [
            calls.map((call) => ({
              target: call.target,
              allowFailure: true,
              callData: call.contractInterface.encodeFunctionData(
                call.method,
                call.args ?? [],
              ),
            })),
          ]),
        },
        blockTag,
      );

      if (response === '0x') {
        return undefined;
      }

      [results] = MULTICALL3_INTERFACE.decodeFunctionResult(
        'aggregate3',
        response,
      );
    } catch {
      // Batched probe reads are an optimization only. If the wrapper call itself
      // is unavailable or returns unusable data, fall back to individual probes.
      return undefined;
    }

    return calls.map((call, index) => {
      const result = results[index];
      if (!result.success || result.returnData === '0x') {
        return undefined;
      }

      try {
        return normalizeDecodedResult(
          call.contractInterface.decodeFunctionResult(
            call.method,
            result.returnData,
          ),
          call.decode,
        );
      } catch (error) {
        if (
          (error as any)?.code === EthersError.INVALID_ARGUMENT ||
          this.isProbeMissError(error)
        ) {
          return undefined;
        }

        throw error;
      }
    });
  }
}
