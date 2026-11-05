import {
  type IHypTokenAdapter,
  type IHypXERC20Adapter,
  type Token,
  TokenStandard,
  XERC20_STANDARDS,
  localAmountFromMessage,
} from '@hyperlane-xyz/sdk';
import type { MultiProviderAdapter } from '@hyperlane-xyz/sdk/providers/MultiProviderAdapter';
import { assert } from '@hyperlane-xyz/utils';

import { normalizeToCanonical } from './balanceUtils.js';

const VELO_STANDARDS = new Set([
  TokenStandard.EvmHypVSXERC20,
  TokenStandard.EvmHypVSXERC20Lockbox,
  TokenStandard.TronHypVSXERC20,
  TokenStandard.TronHypVSXERC20Lockbox,
]);

function hasLimits(
  adapter: IHypTokenAdapter<unknown>,
): adapter is IHypXERC20Adapter<unknown> {
  return (
    'getMintLimit' in adapter &&
    typeof adapter.getMintLimit === 'function' &&
    'getMintMaxLimit' in adapter &&
    typeof adapter.getMintMaxLimit === 'function' &&
    'getBurnLimit' in adapter &&
    typeof adapter.getBurnLimit === 'function' &&
    'getBurnMaxLimit' in adapter &&
    typeof adapter.getBurnMaxLimit === 'function'
  );
}

/** Physical transfer capacity; never substitute this for economic collateral balances. */
export async function getXerc20TransferCapacity({
  source,
  destination,
  multiProvider,
  requested,
  burnFees = 0n,
  sourceMintFees = 0n,
  reservedSourceMint = 0n,
  reservedBurn = 0n,
  reservedMint = 0n,
}: {
  source: Token;
  destination: Token;
  multiProvider: MultiProviderAdapter;
  requested: bigint;
  burnFees?: bigint;
  sourceMintFees?: bigint;
  reservedSourceMint?: bigint;
  reservedBurn?: bigint;
  reservedMint?: bigint;
}): Promise<bigint> {
  let capacity = requested;
  if (XERC20_STANDARDS.includes(source.standard)) {
    const adapter = source.getHypAdapter(multiProvider);
    assert(hasLimits(adapter), `Missing xERC20 limits on ${source.chainName}`);
    if (sourceMintFees > 0n) {
      const availableMint = (await adapter.getMintLimit()) - reservedSourceMint;
      if (availableMint < sourceMintFees) return 0n;
      if (
        VELO_STANDARDS.has(source.standard) &&
        sourceMintFees > (await adapter.getMintMaxLimit()) / 2n
      )
        return 0n;
    }
    const available = (await adapter.getBurnLimit()) - reservedBurn - burnFees;
    capacity = capacity < available ? capacity : available;
  }
  if (XERC20_STANDARDS.includes(destination.standard)) {
    const adapter = destination.getHypAdapter(multiProvider);
    assert(
      hasLimits(adapter),
      `Missing xERC20 limits on ${destination.chainName}`,
    );
    const limit = await adapter.getMintLimit();
    let available = limit > reservedMint ? limit - reservedMint : 0n;
    if (VELO_STANDARDS.has(destination.standard)) {
      const perTransferLimit = (await adapter.getMintMaxLimit()) / 2n;
      available = available < perTransferLimit ? available : perTransferLimit;
    }
    const sourceCapacity = localAmountFromMessage(
      normalizeToCanonical(available, destination),
      source.scale,
    );
    capacity = capacity < sourceCapacity ? capacity : sourceCapacity;
  }
  return capacity > 0n ? capacity : 0n;
}
