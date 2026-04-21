/**
 * Fee program stress tests — discovers on-chain limits by binary search.
 *
 * Discovered limits (legacy tx, no ALTs):
 *
 * TX SIZE LIMITS (bottleneck: ~1232 byte tx payload):
 *   - InitFee (Leaf) max signers:          41  (each H160 = 20 bytes in instruction data)
 *   - SetRoute max signers:                42  (slightly more headroom than InitFee)
 *   - SetWildcardQuoteSigners max signers: 47  (smaller instruction overhead)
 *
 * CU / HEAP LIMITS (bottleneck: BTreeSet deserialization on 32KB heap):
 *   - AddQuoteSigner incremental on Leaf:  409 (account grows via realloc per add)
 *
 * STANDING QUOTE LIMITS:
 *   - TODO: requires secp256k1 quote signing infrastructure to stress test.
 *     Each standing quote entry = 65 bytes (H256 key + i64 issued_at + i64 expiry
 *     + u64 max_fee + u64 half_amount + u8 auth_scope). The per-domain PDA's
 *     BTreeMap will hit the same ~32KB heap limit as signers.
 */
import { address } from '@solana/kit';
import { before, describe, it } from 'mocha';

import { FeeType, FeeStrategyType } from '@hyperlane-xyz/provider-sdk/fee';
import { address as parseAddress } from '@solana/kit';

import { SvmSigner } from '../clients/signer.js';
import { SvmOffchainQuotedLinearFeeWriter } from '../fee/offchain-quoted-linear-fee.js';
import { SvmRoutingFeeWriter } from '../fee/routing-fee.js';
import { deriveFeeSalt, signerToH160 } from '../fee/types.js';
import {
  getAddQuoteSignerInstruction,
  getInitFeeInstruction,
  getSetWildcardQuoteSignersInstruction,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

function makeSigner(index: number): string {
  return '0x' + index.toString(16).padStart(40, '0');
}

async function findLimit(
  tryFn: (n: number) => Promise<void>,
  startLow: number = 1,
): Promise<{ maxSuccess: number; firstFailure: number }> {
  let lastSuccess = startLow;
  let high = startLow;

  while (true) {
    try {
      await tryFn(high);
      console.log(`      probe(${high}): ✓`);
      lastSuccess = high;
      high *= 2;
    } catch (err) {
      console.log(
        `      probe(${high}): ✗ — ${(err as Error).message?.slice(0, 120)}`,
      );
      break;
    }
  }

  let lo = lastSuccess;
  let hi = high;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await tryFn(mid);
      console.log(`      bisect(${mid}): ✓`);
      lo = mid;
    } catch (err) {
      console.log(
        `      bisect(${mid}): ✗ — ${(err as Error).message?.slice(0, 120)}`,
      );
      hi = mid;
    }
  }

  return { maxSuccess: lo, firstFailure: hi };
}

describe('SVM Fee Stress Tests — Finding Limits', function () {
  this.timeout(0);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 500_000_000_000n);
  });

  // ── TX SIZE LIMITS ────────────────────────────────────────────────

  describe('tx size limits', () => {
    // Discovered limit: 41 signers (42 exceeds 1232-byte tx payload)
    it('max signers in InitFee (Leaf)', async () => {
      const { maxSuccess, firstFailure } = await findLimit(async (count) => {
        const signers = Array.from({ length: count }, (_, i) =>
          makeSigner(i + 1),
        );

        const writer = new SvmOffchainQuotedLinearFeeWriter(
          { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
          rpc,
          1,
          signer,
        );

        await writer.create({
          config: {
            type: FeeType.offchainQuotedLinear,
            owner: signer.getSignerAddress(),
            beneficiary: signer.getSignerAddress(),
            maxFee: '1000',
            halfAmount: '500',
            quoteSigners: signers,
          },
        });
      });

      console.log(
        `\n    ► InitFee (Leaf) max signers: ${maxSuccess} (fails at ${firstFailure})`,
      );
    });

    // Discovered limit: 42 signers (43 exceeds 1232-byte tx payload)
    it('max signers in SetRoute', async () => {
      const { maxSuccess, firstFailure } = await findLimit(async (count) => {
        const signers = Array.from({ length: count }, (_, i) =>
          makeSigner(i + 1),
        );

        const writer = new SvmRoutingFeeWriter(
          { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
          rpc,
          1,
          signer,
          { knownRoutersPerDomain: { 1: new Set() } },
        );

        await writer.create({
          config: {
            type: FeeType.routing,
            owner: signer.getSignerAddress(),
            beneficiary: signer.getSignerAddress(),
            routes: {
              1: {
                type: FeeStrategyType.offchainQuotedLinear,
                maxFee: '1000',
                halfAmount: '500',
                quoteSigners: signers,
              },
            },
          },
        });
      });

      console.log(
        `\n    ► SetRoute max signers: ${maxSuccess} (fails at ${firstFailure})`,
      );
    });
  });

  // ── CU / HEAP LIMITS ──────────────────────────────────────────────

  describe('CU and heap limits', () => {
    // Discovered limit: 409 signers (410 fails — BTreeSet deser exceeds
    // the 32KB heap or exhausts CU during account realloc + reserialize).
    it('max signers via incremental AddQuoteSigner on Leaf', async () => {
      const { programAddress: programId } = await resolveProgram(
        { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
        signer,
        rpc,
      );

      const salt = deriveFeeSalt('stress-leaf-incremental');
      const initIx = await getInitFeeInstruction(
        programId,
        signer.signer.address,
        {
          salt,
          owner: parseAddress(signer.getSignerAddress()),
          beneficiary: parseAddress(signer.getSignerAddress()),
          feeData: {
            kind: FeeDataKind.Leaf,
            config: {
              strategy: {
                kind: FeeStrategyKind.Linear,
                params: { maxFee: 1000n, halfAmount: 500n },
              },
              signers: [],
            },
          },
          domainId: 1,
        },
      );
      await signer.send({ instructions: [initIx], skipPreflight: true });

      const { address: feeAccountPda } = await deriveFeeAccountPda(
        programId,
        salt,
      );
      const ownerAddr = parseAddress(signer.getSignerAddress());

      // Add signers in batches of BATCH_SIZE, probing exponentially
      const BATCH_SIZE = 50;
      let totalAdded = 0;
      let failedAt = -1;

      // Phase 1: keep adding batches until one fails
      while (true) {
        const batchStart = totalAdded + 1;
        const batchEnd = totalAdded + BATCH_SIZE;
        let batchFailed = false;

        for (let i = batchStart; i <= batchEnd; i++) {
          try {
            const ix = await getAddQuoteSignerInstruction(
              programId,
              feeAccountPda,
              ownerAddr,
              signerToH160(makeSigner(i)),
              null,
            );
            await signer.send({ instructions: [ix] });
          } catch (err) {
            console.log(
              `      AddQuoteSigner(${i}): ✗ — ${(err as Error).message?.slice(0, 120)}`,
            );
            failedAt = i;
            batchFailed = true;
            break;
          }
        }

        if (batchFailed) break;
        totalAdded = batchEnd;
        console.log(
          `      AddQuoteSigner batch [${batchStart}..${batchEnd}]: ✓ (total: ${totalAdded})`,
        );
      }

      const maxSuccess = failedAt > 0 ? failedAt - 1 : totalAdded;
      console.log(
        `\n    ► Leaf incremental AddQuoteSigner limit: ${maxSuccess} signers (failed at ${failedAt})`,
      );
    });

    // Discovered limit: 47 signers (48 exceeds 1232-byte tx payload).
    // Note: this is a tx size limit, not CU/heap — the full signer set is
    // serialized in the instruction data each call.
    it('max wildcard signers via SetWildcardQuoteSigners on Routing', async () => {
      const { programAddress: programId } = await resolveProgram(
        { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
        signer,
        rpc,
      );

      const salt = deriveFeeSalt('stress-routing-wildcard');
      const initIx = await getInitFeeInstruction(
        programId,
        signer.signer.address,
        {
          salt,
          owner: parseAddress(signer.getSignerAddress()),
          beneficiary: parseAddress(signer.getSignerAddress()),
          feeData: {
            kind: FeeDataKind.Routing,
            config: { wildcardSigners: [] },
          },
          domainId: 1,
        },
      );
      await signer.send({ instructions: [initIx], skipPreflight: true });

      const { address: feeAccountPda } = await deriveFeeAccountPda(
        programId,
        salt,
      );
      const ownerAddr = parseAddress(signer.getSignerAddress());

      const { maxSuccess, firstFailure } = await findLimit(async (count) => {
        const signerBytes = Array.from({ length: count }, (_, i) =>
          signerToH160(makeSigner(i + 1)),
        );
        const ix = getSetWildcardQuoteSignersInstruction(
          programId,
          feeAccountPda,
          ownerAddr,
          signerBytes,
        );
        await signer.send({ instructions: [ix] });
      });

      console.log(
        `\n    ► SetWildcardQuoteSigners limit: ${maxSuccess} (fails at ${firstFailure})`,
      );
    });
  });
});
