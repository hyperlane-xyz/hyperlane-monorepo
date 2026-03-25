import { providers, utils } from 'ethers';

import { Address } from '@hyperlane-xyz/utils';

export const MULTICALL3_ADDRESS =
  '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

export const MULTICALL3_INTERFACE = new utils.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);

const multicallSupportCache = new WeakMap<
  providers.Provider,
  Map<string, Promise<boolean>>
>();

export interface ReadContractCall<T> {
  target: Address;
  contractInterface: utils.Interface;
  method: string;
  args?: readonly unknown[];
  decode?: (decoded: utils.Result) => T;
}

export function normalizeDecodedResult<T>(
  decoded: utils.Result,
  decode?: (decoded: utils.Result) => T,
): T {
  if (decode) {
    return decode(decoded);
  }

  return (decoded.length === 1 ? decoded[0] : decoded) as T;
}

function getBatchContractAddress(batchContractAddress?: string): string {
  return batchContractAddress ?? MULTICALL3_ADDRESS;
}

async function callContractsIndividually<T>(
  provider: providers.Provider,
  calls: ReadContractCall<T>[],
  blockTag: providers.BlockTag,
): Promise<T[]> {
  return Promise.all(
    calls.map(async (call) => {
      const result = await provider.call(
        {
          to: call.target,
          data: call.contractInterface.encodeFunctionData(
            call.method,
            call.args ?? [],
          ),
        },
        blockTag,
      );
      return normalizeDecodedResult(
        call.contractInterface.decodeFunctionResult(call.method, result),
        call.decode,
      );
    }),
  );
}

export async function supportsMulticall(
  provider: providers.Provider,
  batchContractAddress?: string,
): Promise<boolean> {
  const address = getBatchContractAddress(batchContractAddress);
  const cached = multicallSupportCache.get(provider)?.get(address);
  if (cached) {
    return cached;
  }

  const providerCache =
    multicallSupportCache.get(provider) ?? new Map<string, Promise<boolean>>();
  const supportPromise = provider
    .getCode(address)
    .then((code) => code !== '0x')
    .catch(() => false);
  providerCache.set(address, supportPromise);
  multicallSupportCache.set(provider, providerCache);
  return supportPromise;
}

export async function readContractsWithMulticall<T>(
  provider: providers.Provider,
  calls: ReadContractCall<T>[],
  blockTag: providers.BlockTag = 'latest',
  batchContractAddress?: string,
): Promise<T[]> {
  if (!calls.length) {
    return [];
  }

  const address = getBatchContractAddress(batchContractAddress);
  if (!(await supportsMulticall(provider, address))) {
    return callContractsIndividually(provider, calls, blockTag);
  }

  let results: readonly unknown[];
  try {
    const callData = MULTICALL3_INTERFACE.encodeFunctionData('aggregate3', [
      calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: call.contractInterface.encodeFunctionData(
          call.method,
          call.args ?? [],
        ),
      })),
    ]);

    const response = await provider.call(
      {
        to: address,
        data: callData,
      },
      blockTag,
    );
    [results] = MULTICALL3_INTERFACE.decodeFunctionResult(
      'aggregate3',
      response,
    );
  } catch {
    return callContractsIndividually(provider, calls, blockTag);
  }

  return calls.map((call, index) => {
    const result = results[index] as {
      success: boolean;
      returnData: string;
    };
    if (!result.success) {
      throw new Error(
        `Multicall read failed for ${call.method} on ${call.target}`,
      );
    }

    return normalizeDecodedResult(
      call.contractInterface.decodeFunctionResult(
        call.method,
        result.returnData,
      ),
      call.decode,
    );
  });
}
