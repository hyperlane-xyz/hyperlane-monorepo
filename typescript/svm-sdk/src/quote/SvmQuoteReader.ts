import { address as parseAddress } from '@solana/kit';

import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteReader,
  type ReadStandingQuotesOpts,
  type StandingWarpQuoteEntry,
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  type WarpQuoteScope,
  enumerateWarpQuoteCandidates,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert, chunk, fromHexString } from '@hyperlane-xyz/utils';

import { decodeStandingQuotePda } from '../accounts/fee.js';
import { FeeStrategyKind } from '../fee/types.js';
import { deriveFeeAccountPda, deriveStandingQuotePda } from '../pda.js';
import { type SvmRpc } from '../types.js';

import { type SvmQuoteWriterConfig } from './SvmQuoteWriter.js';

// Solana RPC's `getMultipleAccounts` accepts at most 100 addresses per call.
const GET_MULTIPLE_ACCOUNTS_MAX = 100;

interface PdaSeed {
  destination: number;
  targetRouter: string;
  targetRouterBytes: Uint8Array;
}

/**
 * Reads standing offchain-quote entries from a deployed SVM fee program.
 *
 * Per-`(destination, targetRouter)` standing PDAs are non-enumerable on-chain,
 * so the reader walks the candidate scopes the cross-VM helper produces,
 * derives each standing PDA, batches the fetches via `getMultipleAccounts`,
 * and flattens each PDA's `BTreeMap<recipient, FeeStandingQuoteValue>` into
 * per-recipient entries. Transient PDAs are scoped to the original payer's
 * `clientSalt` and intentionally skipped — they're unreadable by anyone but
 * the submitter.
 */
export class SvmQuoteReader implements IRawWarpQuoteReader {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly config: SvmQuoteWriterConfig,
    private readonly context: FeeReadContext,
  ) {}

  async enumerateCandidates(): Promise<WarpQuoteScope[]> {
    return enumerateWarpQuoteCandidates(this.context);
  }

  // `opts.extraRecipients` is intentionally unused: SVM stores recipients
  // inside the per-(dest, target_router) PDA's BTreeMap, which this reader
  // enumerates fully — there's no non-enumerable storage that callers would
  // need to hint at.
  async readStandingQuotes(
    _opts?: ReadStandingQuotesOpts,
  ): Promise<StandingWarpQuoteEntry[]> {
    const candidates = await this.enumerateCandidates();
    const seeds = uniquePdaSeeds(candidates);

    const programId = parseAddress(this.config.feeProgramId);
    const feeAccountPda = await deriveFeeAccountPda(
      programId,
      this.config.salt,
    );

    const pdaAddresses = await Promise.all(
      seeds.map(async (s) => {
        const pda = await deriveStandingQuotePda(
          programId,
          feeAccountPda.address,
          s.destination,
          s.targetRouterBytes,
        );
        return pda.address;
      }),
    );

    const addressChunks = chunk(pdaAddresses, GET_MULTIPLE_ACCOUNTS_MAX);
    const seedChunks = chunk(seeds, GET_MULTIPLE_ACCOUNTS_MAX);

    const entries: StandingWarpQuoteEntry[] = [];
    for (let i = 0; i < addressChunks.length; i++) {
      const addressChunk = addressChunks[i];
      const seedChunk = seedChunks[i];
      assert(addressChunk && seedChunk, `Missing quote chunk at index ${i}`);
      const response = await this.rpc
        .getMultipleAccounts(addressChunk, { encoding: 'base64' })
        .send();

      for (let j = 0; j < seedChunk.length; j++) {
        const acct = response.value[j];
        if (!acct) continue;
        const encodedData = acct.data[0];
        assert(encodedData, `Missing account data at quote index ${j}`);
        const decoded = decodeStandingQuotePda(
          Uint8Array.from(Buffer.from(encodedData, 'base64')),
        );
        if (!decoded) continue;

        const seed: PdaSeed | undefined = seedChunk[j];
        assert(seed, `Missing quote seed at index ${j}`);
        for (const [recipient, entry] of decoded.quotes) {
          if (entry.feeData.kind !== FeeStrategyKind.Linear) continue;
          entries.push({
            scope: {
              destination: seed.destination,
              recipient,
              targetRouter: seed.targetRouter,
              amount: WARP_QUOTE_AMOUNT_WILDCARD,
            },
            params: {
              maxFee: entry.feeData.params.maxFee,
              halfAmount: entry.feeData.params.halfAmount,
            },
            issuedAt: Number(entry.issuedAt),
            expiry: Number(entry.expiry),
          });
        }
      }
    }
    return entries;
  }
}

function uniquePdaSeeds(candidates: WarpQuoteScope[]): PdaSeed[] {
  const seen = new Map<string, PdaSeed>();
  for (const scope of candidates) {
    const key = `${scope.destination}|${scope.targetRouter}`;
    if (seen.has(key)) continue;
    const targetRouterBytes =
      scope.targetRouter === WARP_TARGET_ROUTER_NONE
        ? new Uint8Array(32)
        : Uint8Array.from(fromHexString(scope.targetRouter));
    seen.set(key, {
      destination: scope.destination,
      targetRouter: scope.targetRouter,
      targetRouterBytes,
    });
  }
  return Array.from(seen.values());
}
