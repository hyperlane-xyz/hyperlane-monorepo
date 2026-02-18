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
  address: Address,
  results: (TokenAmount | null)[],
  options?: TokenBalanceBatchOptions,
): Promise<void> {
  const multiProvider: MultiProvider = multiProtocolProvider.toMultiProvider();
  const multicall3Address = multiProvider.tryGetEvmBatchContractAddress(chain);

  const calls: EvmReadCall[] = entries.map(({ token }) => {
    if (token.isNative() && multicall3Address) {
      return buildGetEthBalanceCall(multicall3Address, address);
    }
    return {
      contract: { address: token.addressOrDenom, interface: erc20Interface },
      functionName: 'balanceOf',
      args: [address],
      allowFailure: true,
    };
  });

  const multicallOptions: EvmMulticallReadOptions = {};
  if (options?.blockTag !== undefined) {
    multicallOptions.blockTag = options.blockTag;
  }

  try {
    const rawResults = await multiProvider.multicall(
      chain,
      calls,
      multicallOptions,
    );

    for (let i = 0; i < entries.length; i++) {
      const raw = rawResults[i];
      if (raw == null) {
        results[entries[i].originalIndex] = null;
        continue;
      }
      try {
        const balance = BigNumber.isBigNumber(raw)
          ? raw.toBigInt()
          : BigInt(String(raw));
        results[entries[i].originalIndex] = new TokenAmount(
          balance,
          entries[i].token,
        );
      } catch {
        results[entries[i].originalIndex] = null;
      }
    }
  } catch (error) {
    logger.debug(
      { chain, error },
      'EVM multicall batch failed; all entries null',
    );
  }
}
