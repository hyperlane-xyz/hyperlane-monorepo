import { BigNumber, providers, utils } from 'ethers';
import type { Provider as ZKSyncProvider } from 'zksync-ethers';

import { IMulticall3__factory } from '@hyperlane-xyz/core';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import type { ChainNameOrId } from '../types.js';

import type { MultiProvider } from './MultiProvider.js';

type Multicall3Result = {
  success: boolean;
  returnData: string;
};

type EvmReadableContract = {
  address: string;
  interface: utils.Interface;
};
type EvmProvider = providers.Provider | ZKSyncProvider;

export interface EvmReadCall<T = unknown> {
  contract: EvmReadableContract;
  functionName: string;
  args?: readonly unknown[];
  /**
   * If true, a failed sub-call returns null instead of throwing.
   * This does not control Multicall3 aggregate3's per-call allowFailure flag.
   */
  allowFailure?: boolean;
  transform?: (result: unknown) => T;
}

type EvmReadCallMap = Record<string, EvmReadCall<unknown>>;
type EvmReadCallResult<TCall> =
  TCall extends EvmReadCall<infer TResult>
    ? TCall extends { allowFailure: true }
      ? TResult | null
      : TResult
    : unknown;

export type EvmReadCallResults<TCalls extends EvmReadCallMap> = {
  [K in keyof TCalls]: EvmReadCallResult<TCalls[K]>;
};

export interface EvmMulticallReadOptions {
  /**
   * Optional explicit multicall contract address override.
   * If omitted, chain metadata resolution is used.
   */
  batchContractAddress?: Address;
  /**
   * Optional block tag forwarded to eth_call.
   */
  blockTag?: providers.BlockTag;
  /**
   * Forces direct RPC reads and skips multicall entirely.
   */
  forceDirectReads?: boolean;
}

const logger = rootLogger.child({ module: 'EvmMulticall3' });

const batchContractSupportCache = new Map<string, boolean>();
const MAX_BATCH_SUPPORT_CACHE_SIZE = 500;
const multicall3Interface = IMulticall3__factory.createInterface();

function cacheBatchSupport(cacheKey: string): void {
  if (batchContractSupportCache.size >= MAX_BATCH_SUPPORT_CACHE_SIZE) {
    const oldest = batchContractSupportCache.keys().next().value;
    if (oldest) batchContractSupportCache.delete(oldest);
  }
  batchContractSupportCache.set(cacheKey, true);
}

function normalizeDecodedResult(result: utils.Result): unknown {
  return result.length === 1 ? result[0] : [...result];
}

export function clearMulticall3BatchSupportCache(): void {
  batchContractSupportCache.clear();
}

async function runDirectReadCall<T>(
  provider: EvmProvider,
  call: EvmReadCall<T>,
  blockTag?: providers.BlockTag,
): Promise<T | null> {
  try {
    const callData = call.contract.interface.encodeFunctionData(
      call.functionName,
      call.args ? [...call.args] : [],
    );
    const rawResult = await provider.call(
      {
        to: call.contract.address,
        data: callData,
      },
      blockTag,
    );
    const decodedResult = call.contract.interface.decodeFunctionResult(
      call.functionName,
      rawResult,
    );
    const normalizedResult = normalizeDecodedResult(decodedResult);
    return call.transform
      ? call.transform(normalizedResult)
      : (normalizedResult as T);
  } catch (error) {
    if (call.allowFailure) return null;
    throw error;
  }
}

async function isBatchContractAvailable(
  provider: EvmProvider,
  chainName: string,
  batchContractAddress: Address,
): Promise<boolean> {
  const cacheKey = `${chainName}:${batchContractAddress.toLowerCase()}`;
  const cached = batchContractSupportCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const code = await provider.getCode(batchContractAddress);
    const isAvailable = code !== '0x';
    // Cache only positive detections to avoid stale negative cache entries.
    if (isAvailable) cacheBatchSupport(cacheKey);
    return isAvailable;
  } catch (error) {
    logger.debug(
      {
        chain: chainName,
        batchContractAddress,
        error,
      },
      'Failed checking multicall3 code; skipping batch reads',
    );
    return false;
  }
}

async function runMulticallAggregate3(
  provider: EvmProvider,
  batchContractAddress: Address,
  calls: Array<{ target: string; allowFailure: boolean; callData: string }>,
  blockTag?: providers.BlockTag,
): Promise<Multicall3Result[]> {
  const calldata = multicall3Interface.encodeFunctionData('aggregate3', [
    calls,
  ]);
  const rawResult = await provider.call(
    {
      to: batchContractAddress,
      data: calldata,
    },
    blockTag,
  );
  return multicall3Interface.decodeFunctionResult(
    'aggregate3',
    rawResult,
  )[0] as Multicall3Result[];
}

export async function readEvmCallsWithMulticall<MetaExt = {}>(
  multiProvider: MultiProvider<MetaExt>,
  chain: ChainNameOrId,
  calls: EvmReadCall[],
  options: EvmMulticallReadOptions = {},
): Promise<unknown[]> {
  if (!calls.length) return [];

  const provider = multiProvider.getProvider(chain);
  if (options.forceDirectReads) {
    return Promise.all(
      calls.map((call) => runDirectReadCall(provider, call, options.blockTag)),
    );
  }

  const batchContractAddress =
    options.batchContractAddress ??
    multiProvider.tryGetEvmBatchContractAddress(chain);
  if (!batchContractAddress) {
    return Promise.all(
      calls.map((call) => runDirectReadCall(provider, call, options.blockTag)),
    );
  }

  const chainName = multiProvider.getChainName(chain);
  const canBatch = await isBatchContractAvailable(
    provider,
    chainName,
    batchContractAddress,
  );

  if (!canBatch) {
    return Promise.all(
      calls.map((call) => runDirectReadCall(provider, call, options.blockTag)),
    );
  }

  const encodedCalls = calls.map((call) => ({
    target: call.contract.address,
    allowFailure: true,
    callData: call.contract.interface.encodeFunctionData(
      call.functionName,
      call.args ? [...call.args] : [],
    ),
  }));

  try {
    const results = await runMulticallAggregate3(
      provider,
      batchContractAddress,
      encodedCalls,
      options.blockTag,
    );
    if (results.length !== calls.length) {
      throw new Error(
        `Unexpected multicall3 response length ${results.length}, expected ${calls.length}`,
      );
    }

    return Promise.all(
      results.map(async (result, index) => {
        const call = calls[index];
        if (!result.success) {
          if (call.allowFailure) return null;
          return runDirectReadCall(provider, call, options.blockTag);
        }

        try {
          const decodedResult = call.contract.interface.decodeFunctionResult(
            call.functionName,
            result.returnData,
          );
          const normalizedResult = normalizeDecodedResult(decodedResult);
          return call.transform
            ? call.transform(normalizedResult)
            : normalizedResult;
        } catch (error) {
          logger.debug(
            {
              chain: chainName,
              batchContractAddress,
              target: call.contract.address,
              functionName: call.functionName,
              error,
            },
            'Failed decoding multicall result; retrying direct read',
          );
          return runDirectReadCall(provider, call, options.blockTag);
        }
      }),
    );
  } catch (error) {
    logger.debug(
      {
        chain: chainName,
        batchContractAddress,
        error,
      },
      'Multicall3 read failed; retrying direct reads',
    );
    return Promise.all(
      calls.map((call) => runDirectReadCall(provider, call, options.blockTag)),
    );
  }
}

export async function readEvmCallMapWithMulticall<
  MetaExt = {},
  TCalls extends EvmReadCallMap = EvmReadCallMap,
>(
  multiProvider: MultiProvider<MetaExt>,
  chain: ChainNameOrId,
  calls: TCalls,
  options: EvmMulticallReadOptions = {},
): Promise<EvmReadCallResults<TCalls>> {
  const entries = Object.entries(calls) as Array<[keyof TCalls, EvmReadCall]>;
  const results = await readEvmCallsWithMulticall(
    multiProvider,
    chain,
    entries.map(([, call]) => call),
    options,
  );

  assert(
    results.length === entries.length,
    `Unexpected multicall results length ${results.length}, expected ${entries.length}`,
  );

  const response = {} as EvmReadCallResults<TCalls>;
  for (const [index, [key]] of entries.entries()) {
    (response as Record<string, unknown>)[key as string] = results[index];
  }
  return response;
}

export function buildGetEthBalanceCall(
  multicall3Address: string,
  targetAddress: string,
): EvmReadCall<bigint> {
  return {
    contract: {
      address: multicall3Address,
      interface: multicall3Interface,
    },
    functionName: 'getEthBalance',
    args: [targetAddress],
    transform: (result) => (result as BigNumber).toBigInt(),
  };
}
