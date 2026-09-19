import type { providers } from 'ethers';
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isHex,
  multicall3Abi,
  type Hex,
} from 'viem';

import { assert } from '@hyperlane-xyz/utils';

import type { EthJsonRpcBlockParameterTag } from '../metadata/chainMetadataTypes.js';
import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';

import type { Token } from './Token.js';
import { TokenStandard } from './TokenStandard.js';
import { EvmHypCollateralAdapter } from './adapters/EvmTokenAdapter.js';
import type {
  IHypTokenAdapter,
  ITokenAdapter,
} from './adapters/ITokenAdapter.js';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MAX_BATCH_SIZE = 128;
// Refresh proxy-derived metadata without discarding it on every five-minute poll.
const METADATA_TTL_MS = 15 * 60_000;
type BlockTag = number | EthJsonRpcBlockParameterTag | undefined;
type Read = {
  target: Hex;
  data: Hex;
  resolve: (result: Hex) => void;
  reject: (error: unknown) => void;
  waiters: Array<{
    resolve: (result: Hex) => void;
    reject: (error: unknown) => void;
  }>;
};

/** Polling reads only: balances are never cached. Own one reader per provider configuration. */
export class TokenBalanceReader {
  private readonly adapters = new WeakMap<
    Token,
    {
      expiresAt: number;
      hyp?: IHypTokenAdapter<unknown>;
      token?: ITokenAdapter<unknown>;
    }
  >();
  private readonly queues = new WeakMap<
    providers.Provider,
    Map<BlockTag, Map<string, Read>>
  >();

  constructor(
    private readonly multiProvider: MultiProviderAdapter<{ mailbox?: string }>,
  ) {}

  private entry(token: Token) {
    let entry = this.adapters.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      entry = { expiresAt: Date.now() + METADATA_TTL_MS };
      this.adapters.set(token, entry);
    }
    return entry;
  }

  async getBridgedSupply(
    token: Token,
    blockTag?: BlockTag,
  ): Promise<bigint | undefined> {
    const entry = this.entry(token);
    const adapter = (entry.hyp ??= token.getHypAdapter(this.multiProvider));
    if (
      token.standard === TokenStandard.EvmHypCollateral &&
      adapter instanceof EvmHypCollateralAdapter
    ) {
      return this.balanceOf(
        token.chainName,
        await adapter.getWrappedTokenAddress(),
        token.addressOrDenom,
        blockTag,
      );
    }
    if (token.standard === TokenStandard.EvmHypSynthetic) {
      return this.readUint(
        token.chainName,
        token.addressOrDenom,
        encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }),
        'totalSupply',
        blockTag,
      );
    }
    return adapter.getBridgedSupply({ blockTag });
  }

  async getBalance(token: Token, owner: string): Promise<bigint> {
    const entry = this.entry(token);
    const adapter = (entry.token ??= token.getAdapter(this.multiProvider));
    if (
      token.standard === TokenStandard.EvmHypCollateral &&
      adapter instanceof EvmHypCollateralAdapter
    ) {
      return this.balanceOf(
        token.chainName,
        await adapter.getWrappedTokenAddress(),
        owner,
      );
    }
    if (
      token.standard === TokenStandard.EvmHypSynthetic ||
      token.standard === TokenStandard.ERC20
    ) {
      return this.balanceOf(token.chainName, token.addressOrDenom, owner);
    }
    return adapter.getBalance(owner);
  }

  private balanceOf(
    chain: string,
    target: string,
    owner: string,
    blockTag?: BlockTag,
  ) {
    return this.readUint(
      chain,
      target,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [getAddress(owner)],
      }),
      'balanceOf',
      blockTag,
    );
  }

  private async readUint(
    chain: string,
    target: string,
    data: Hex,
    method: 'balanceOf' | 'totalSupply',
    blockTag?: BlockTag,
  ): Promise<bigint> {
    const result = await this.enqueue(
      this.multiProvider.getEthersV5Provider(chain),
      getAddress(target),
      data,
      blockTag,
    );
    return decodeFunctionResult({
      abi: erc20Abi,
      functionName: method,
      data: result,
    });
  }

  private enqueue(
    provider: providers.Provider,
    target: Hex,
    data: Hex,
    blockTag: BlockTag,
  ): Promise<Hex> {
    let byBlock = this.queues.get(provider);
    if (!byBlock) {
      byBlock = new Map();
      this.queues.set(provider, byBlock);
    }
    let queue = byBlock.get(blockTag);
    if (!queue) {
      queue = new Map();
      byBlock.set(blockTag, queue);
      const pending = queue;
      const blocks = byBlock;
      setTimeout(() => {
        blocks.delete(blockTag);
        void this.flush(provider, [...pending.values()], blockTag);
      }, 0);
    }
    const key = `${target.toLowerCase()}:${data}`;
    const pending = queue;
    return new Promise<Hex>((resolve, reject) => {
      const existing = pending.get(key);
      if (existing) {
        existing.waiters.push({ resolve, reject });
      } else {
        const waiters = [{ resolve, reject }];
        pending.set(key, {
          target,
          data,
          waiters,
          resolve: (result) => {
            for (const waiter of waiters) waiter.resolve(result);
          },
          reject: (error) => {
            for (const waiter of waiters) waiter.reject(error);
          },
        });
      }
    });
  }

  private async flush(
    provider: providers.Provider,
    reads: Read[],
    blockTag: BlockTag,
  ): Promise<void> {
    try {
      // Probe at the same block: historical reads may predate Multicall deployment.
      // A missing contract is a supported direct-read path, not an RPC-error fallback.
      const batch =
        reads.length >= 3 &&
        (await provider.getCode(MULTICALL3, blockTag)) !== '0x';
      if (!batch) {
        await Promise.all(
          reads.map(async (read) => {
            try {
              const result = await provider.call(
                { to: read.target, data: read.data },
                blockTag,
              );
              assert(isHex(result), 'Invalid token read response');
              read.resolve(result);
            } catch (error) {
              read.reject(error);
            }
          }),
        );
        return;
      }
      for (let offset = 0; offset < reads.length; offset += MAX_BATCH_SIZE) {
        const chunk = reads.slice(offset, offset + MAX_BATCH_SIZE);
        const data = encodeFunctionData({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          args: [
            chunk.map((r) => ({
              target: r.target,
              allowFailure: true,
              callData: r.data,
            })),
          ],
        });
        const response = await provider.call(
          { to: MULTICALL3, data },
          blockTag,
        );
        assert(isHex(response), 'Invalid Multicall response');
        const results = decodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          data: response,
        });
        assert(
          results.length === chunk.length,
          'Incomplete Multicall response',
        );
        for (const [index, result] of results.entries()) {
          const read = chunk[index];
          if (result.success) read.resolve(result.returnData);
          else
            read.reject(
              new Error(
                `Token read reverted: ${read.target} (${read.data.slice(0, 10)})`,
              ),
            );
        }
      }
    } catch (error) {
      for (const read of reads) read.reject(error);
    }
  }
}
