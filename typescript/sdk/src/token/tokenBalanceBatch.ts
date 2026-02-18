import { BigNumber, providers, utils } from 'ethers';

import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import type { MultiProvider } from '../providers/MultiProvider.js';
import type {
  EvmMulticallReadOptions,
  EvmReadCall,
} from '../providers/multicall3.js';
import { buildGetEthBalanceCall } from '../providers/multicall3.js';

import type { IToken } from './IToken.js';
import { TokenAmount } from './TokenAmount.js';
import { TOKEN_STANDARD_TO_PROTOCOL } from './TokenStandard.js';

const logger = rootLogger.child({ module: 'tokenBalanceBatch' });

const erc20Interface = new utils.Interface([
  'function balanceOf(address) view returns (uint256)',
]);

export interface TokenBalanceBatchOptions {
  blockTag?: providers.BlockTag;
}

/**
 * Fetch balances for multiple tokens in a single batch per chain.
 * EVM tokens are grouped and read via multicall3; non-EVM tokens
 * fall back to individual adapter calls.
 *
 * Returns results in the same order as the input tokens array.
 * Failed reads return null.
 */
export async function getTokenBalancesBatch(
  tokens: IToken[],
  multiProtocolProvider: MultiProtocolProvider,
  address: Address,
  options?: TokenBalanceBatchOptions,
): Promise<(TokenAmount | null)[]> {
  if (tokens.length === 0) return [];

  let multiProvider: MultiProvider | null = null;
  try {
    multiProvider = multiProtocolProvider.toMultiProvider();
  } catch (error) {
    logger.debug({ error }, 'Failed creating MultiProvider for batch reads');
  }

  // Group tokens by chain, preserving original indices
  const chainGroups = new Map<
    string,
    Array<{ token: IToken; originalIndex: number }>
  >();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const chain = token.chainName;
    let group = chainGroups.get(chain);
    if (!group) {
      group = [];
      chainGroups.set(chain, group);
    }
    group.push({ token, originalIndex: i });
  }

  const results: (TokenAmount | null)[] = Array.from<TokenAmount | null>({
    length: tokens.length,
  }).fill(null);

  // Process each chain group in parallel
  await Promise.all(
    Array.from(chainGroups.entries()).map(([chain, group]) =>
      processChainGroup(
        chain,
        group,
        multiProtocolProvider,
        multiProvider,
        address,
        results,
        options,
      ),
    ),
  );

  return results;
}

async function processChainGroup(
  chain: string,
  group: Array<{ token: IToken; originalIndex: number }>,
  multiProtocolProvider: MultiProtocolProvider,
  multiProvider: MultiProvider | null,
  address: Address,
  results: (TokenAmount | null)[],
  options?: TokenBalanceBatchOptions,
): Promise<void> {
  const evmEntries: Array<{ token: IToken; originalIndex: number }> = [];
  const nonEvmEntries: Array<{ token: IToken; originalIndex: number }> = [];

  for (const entry of group) {
    const protocol = TOKEN_STANDARD_TO_PROTOCOL[entry.token.standard];
    if (protocol === ProtocolType.Ethereum) {
      evmEntries.push(entry);
    } else {
      nonEvmEntries.push(entry);
    }
  }

  // Process EVM tokens via multicall
  if (evmEntries.length > 0) {
    await processEvmBatch(
      chain,
      evmEntries,
      multiProtocolProvider,
      multiProvider,
      address,
      results,
      options,
    );
  }

  // Process non-EVM tokens individually
  await Promise.all(
    nonEvmEntries.map(async ({ token, originalIndex }) => {
      try {
        results[originalIndex] = await token.getBalance(
          multiProtocolProvider,
          address,
        );
      } catch (error) {
        logger.debug(
          { chain, token: token.addressOrDenom, error },
          'Non-EVM balance fetch failed',
        );
        results[originalIndex] = null;
      }
    }),
  );
}

async function processEvmBatch(
  chain: string,
  entries: Array<{ token: IToken; originalIndex: number }>,
  multiProtocolProvider: MultiProtocolProvider,
  multiProvider: MultiProvider | null,
  address: Address,
  results: (TokenAmount | null)[],
  options?: TokenBalanceBatchOptions,
): Promise<void> {
  if (!multiProvider) {
    await Promise.all(
      entries.map(async ({ token, originalIndex }) => {
        try {
          results[originalIndex] = await token.getBalance(
            multiProtocolProvider,
            address,
          );
        } catch (error) {
          logger.debug(
            { chain, token: token.addressOrDenom, error },
            'EVM balance fetch failed without MultiProvider',
          );
          results[originalIndex] = null;
        }
      }),
    );
    return;
  }

  const multicall3Address = multiProvider.tryGetEvmBatchContractAddress(chain);
  let provider: providers.Provider;
  try {
    provider = multiProvider.getProvider(chain) as providers.Provider;
  } catch (error) {
    logger.debug(
      { chain, error },
      'Missing EVM provider for batch reads; falling back to individual reads',
    );
    await Promise.all(
      entries.map(async ({ token, originalIndex }) => {
        try {
          results[originalIndex] = await token.getBalance(
            multiProtocolProvider,
            address,
          );
        } catch (fallbackError) {
          logger.debug(
            { chain, token: token.addressOrDenom, error: fallbackError },
            'EVM fallback balance fetch failed',
          );
          results[originalIndex] = null;
        }
      }),
    );
    return;
  }

  let nativeBatchReadsSupported = false;
  if (multicall3Address) {
    try {
      nativeBatchReadsSupported =
        (await provider.getCode(multicall3Address)) !== '0x';
    } catch (error) {
      logger.debug(
        { chain, multicall3Address, error },
        'Failed checking multicall3 code for native balance reads',
      );
    }
  }

  const batchedEntries: Array<{
    entry: { token: IToken; originalIndex: number };
    call: EvmReadCall;
  }> = [];
  const directEntries: Array<{ token: IToken; originalIndex: number }> = [];

  for (const entry of entries) {
    if (entry.token.isNative()) {
      if (multicall3Address && nativeBatchReadsSupported) {
        batchedEntries.push({
          entry,
          call: buildGetEthBalanceCall(multicall3Address, address),
        });
      } else {
        directEntries.push(entry);
      }
      continue;
    }

    batchedEntries.push({
      entry,
      call: {
        contract: {
          address: entry.token.addressOrDenom,
          interface: erc20Interface,
        },
        functionName: 'balanceOf',
        args: [address],
        allowFailure: true,
      },
    });
  }

  const multicallOptions: EvmMulticallReadOptions = {};
  if (options?.blockTag !== undefined) {
    multicallOptions.blockTag = options.blockTag;
  }

  if (batchedEntries.length > 0) {
    try {
      const rawResults = await multiProvider.multicall(
        chain,
        batchedEntries.map((e) => e.call),
        multicallOptions,
      );

      for (let i = 0; i < batchedEntries.length; i++) {
        const raw = rawResults[i];
        const { token, originalIndex } = batchedEntries[i].entry;
        if (raw == null) {
          results[originalIndex] = null;
          continue;
        }
        try {
          const balance = BigNumber.isBigNumber(raw)
            ? raw.toBigInt()
            : BigInt(String(raw));
          results[originalIndex] = new TokenAmount(balance, token);
        } catch {
          results[originalIndex] = null;
        }
      }
    } catch (error) {
      logger.debug(
        { chain, error },
        'EVM multicall batch failed; falling back to individual token reads',
      );
      directEntries.push(...batchedEntries.map((e) => e.entry));
    }
  }

  await Promise.all(
    directEntries.map(async ({ token, originalIndex }) => {
      try {
        results[originalIndex] = await token.getBalance(
          multiProtocolProvider,
          address,
        );
      } catch (error) {
        logger.debug(
          { chain, token: token.addressOrDenom, error },
          'EVM fallback balance fetch failed',
        );
        results[originalIndex] = null;
      }
    }),
  );
}
