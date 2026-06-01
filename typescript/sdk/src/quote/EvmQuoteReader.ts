import { providers as ethersProviders } from 'ethers';

import { OffchainQuotedLinearFee__factory } from '@hyperlane-xyz/core';
import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteReader,
  type StandingWarpQuoteEntry,
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  type WarpQuoteScope,
  enumerateWarpQuoteCandidates,
} from '@hyperlane-xyz/provider-sdk/quote';

/**
 * Reads standing offchain-quote entries from a deployed `OffchainQuotedLinearFee`.
 * The contract stores standing quotes in a non-enumerable `quotes(dest, recipient)`
 * mapping keyed by `(uint32 destination, bytes32 recipient)`, so the reader
 * enumerates the `(dest, recipient)` candidates the cross-VM helper produces and
 * queries each — dropping `expiry == 0` (unset slots).
 *
 * EVM has no on-chain `targetRouter` dimension; returned entries set
 * `targetRouter = WARP_TARGET_ROUTER_NONE`. When this leaf sits under a
 * CrossCollateralRoutingFee, callers that need to distinguish sibling-leaf
 * entries label them at a higher layer using the deploy-config router key.
 */
export class EvmQuoteReader implements IRawWarpQuoteReader {
  constructor(
    private readonly provider: ethersProviders.Provider,
    private readonly feeAddress: string,
    private readonly context: FeeReadContext,
  ) {}

  async enumerateCandidates(): Promise<WarpQuoteScope[]> {
    return enumerateWarpQuoteCandidates(this.context).filter(
      (s) => s.targetRouter === WARP_TARGET_ROUTER_NONE,
    );
  }

  async readStandingQuotes(): Promise<StandingWarpQuoteEntry[]> {
    const candidates = await this.enumerateCandidates();
    const contract = OffchainQuotedLinearFee__factory.connect(
      this.feeAddress,
      this.provider,
    );

    const seen = new Set<string>();
    const uniqueKeys: Array<{ destination: number; recipient: string }> = [];
    for (const scope of candidates) {
      const key = `${scope.destination}|${scope.recipient}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueKeys.push({
        destination: scope.destination,
        recipient: scope.recipient,
      });
    }

    const results: StandingWarpQuoteEntry[] = [];
    for (const { destination, recipient } of uniqueKeys) {
      const stored = await contract.quotes(destination, recipient);
      const expiry = Number(stored.expiry);
      if (expiry === 0) continue;
      results.push({
        scope: {
          destination,
          recipient,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: WARP_QUOTE_AMOUNT_WILDCARD,
        },
        params: {
          maxFee: BigInt(stored.maxFee.toString()),
          halfAmount: BigInt(stored.halfAmount.toString()),
        },
        issuedAt: Number(stored.issuedAt),
        expiry,
      });
    }
    return results;
  }
}
