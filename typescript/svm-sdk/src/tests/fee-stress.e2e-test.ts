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
 * STANDING QUOTE LIMITS (bottleneck: BTreeMap deserialization on 32KB heap):
 *   - Standing quotes per domain PDA (Leaf):  113 (each entry = 65 bytes)
 *   - Standing quotes per domain PDA (CC):    113 (same PDA structure as Leaf)
 */
import { address, address as parseAddress } from '@solana/kit';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { before, describe, it } from 'mocha';

import { FeeType, FeeStrategyType } from '@hyperlane-xyz/provider-sdk/fee';

import { SvmSigner } from '../clients/signer.js';
import { concatBytes, u32le, u64le } from '../codecs/binary.js';
import { SvmOffchainQuotedLinearFeeWriter } from '../fee/offchain-quoted-linear-fee.js';
import { SvmRoutingFeeWriter } from '../fee/routing-fee.js';
import {
  deriveFeeSalt,
  signerToH160,
  FeeDataKind,
  FeeStrategyKind,
} from '../fee/types.js';
import {
  getAddQuoteSignerInstruction,
  getInitFeeInstruction,
  getSetWildcardQuoteSignersInstruction,
  getSubmitStandingQuoteInstruction,
  type SvmSignedQuoteData,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

function makeSigner(index: number): string {
  return '0x' + index.toString(16).padStart(40, '0');
}

// ── secp256k1 quote signing helpers ─────────────────────────────────

const DOMAIN_TAG = new TextEncoder().encode('HyperlaneSvmQuote');

/** Derive H160 address from a secp256k1 private key. */
function privateKeyToH160(privKey: Uint8Array): Uint8Array {
  const pubKeyUncompressed = secp256k1.getPublicKey(privKey, false).slice(1); // drop 0x04 prefix
  const hash = keccak_256(pubKeyUncompressed);
  return hash.slice(12); // last 20 bytes
}

/** Build scoped_salt = keccak256(payer || client_salt). */
function computeScopedSalt(
  payer: Uint8Array,
  clientSalt: Uint8Array,
): Uint8Array {
  return keccak_256(Uint8Array.from([...payer, ...clientSalt]));
}

/** Encode a u48 big-endian timestamp into 6 bytes. */
function u48be(value: number): Uint8Array {
  const buf = new Uint8Array(6);
  for (let i = 5; i >= 0; i--) {
    buf[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return buf;
}

/**
 * Build and sign a standing quote for a given recipient.
 * Standing quote: expiry > issued_at.
 */
function signStandingQuote(opts: {
  privKey: Uint8Array;
  feeAccountPda: Uint8Array;
  domainId: number;
  destinationDomain: number;
  recipient: Uint8Array;
  amount: bigint;
  maxFee: bigint;
  halfAmount: bigint;
  issuedAt: number;
  expiry: number;
  clientSalt: Uint8Array;
  payer: Uint8Array;
}): SvmSignedQuoteData {
  // FeeQuoteContext: dest_domain(u32 LE) + recipient(H256) + amount(u64 LE) = 44 bytes
  const context = Uint8Array.from(
    concatBytes(
      u32le(opts.destinationDomain),
      opts.recipient,
      u64le(opts.amount),
    ),
  );
  // FeeQuoteData: max_fee(u64 LE) + half_amount(u64 LE) = 16 bytes
  const data = Uint8Array.from(
    concatBytes(u64le(opts.maxFee), u64le(opts.halfAmount)),
  );

  const issuedAtBytes = u48be(opts.issuedAt);
  const expiryBytes = u48be(opts.expiry);
  const scopedSalt = computeScopedSalt(opts.payer, opts.clientSalt);

  // message_hash = keccak256(DOMAIN_TAG || fee_account || domain_id_le || keccak(context) || keccak(data) || issued_at || expiry || scoped_salt)
  const messageHash = keccak_256(
    Uint8Array.from([
      ...DOMAIN_TAG,
      ...opts.feeAccountPda,
      ...new Uint8Array(new Uint32Array([opts.domainId]).buffer),
      ...keccak_256(context),
      ...keccak_256(data),
      ...issuedAtBytes,
      ...expiryBytes,
      ...scopedSalt,
    ]),
  );

  const sig = secp256k1.sign(messageHash, opts.privKey);
  const signature = new Uint8Array(65);
  signature.set(sig.toCompactRawBytes(), 0);
  signature[64] = sig.recovery;

  return {
    context,
    data,
    issuedAt: issuedAtBytes,
    expiry: expiryBytes,
    clientSalt: opts.clientSalt,
    signature,
  };
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

    // Discovered limit: 113 standing quotes per domain PDA (114 fails).
    // Each entry = 32 (H256 key) + 8+8+8+8+1 (value) = 65 bytes in BTreeMap.
    // ~7.3KB of data at 113 entries; BTreeMap deser overhead hits heap before signers.
    it('max standing quotes per domain PDA (Leaf)', async () => {
      const quoteSignerPrivKey = new Uint8Array(32);
      quoteSignerPrivKey[31] = 42;
      const quoteSignerH160 = privateKeyToH160(quoteSignerPrivKey);
      const quoteSignerHex =
        '0x' +
        Array.from(quoteSignerH160)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

      const { programAddress: programId } = await resolveProgram(
        { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
        signer,
        rpc,
      );

      const salt = deriveFeeSalt('stress-standing-quotes');
      const DOMAIN_ID = 1;
      const DEST_DOMAIN = 10;

      const initIx = await getInitFeeInstruction(
        programId,
        signer.signer.address,
        {
          salt,
          beneficiary: parseAddress(signer.getSignerAddress()),
          feeData: {
            kind: FeeDataKind.Leaf,
            config: {
              strategy: {
                kind: FeeStrategyKind.Linear,
                params: { maxFee: 1000n, halfAmount: 500n },
              },
              signers: [signerToH160(quoteSignerHex)],
            },
          },
          domainId: DOMAIN_ID,
        },
      );
      await signer.send({ instructions: [initIx], skipPreflight: true });

      const { address: feeAccountPda } = await deriveFeeAccountPda(
        programId,
        salt,
      );

      // Get the fee account PDA raw bytes for signing
      const { getAddressEncoder } = await import('@solana/kit');
      const addrEncoder = getAddressEncoder();
      const feeAccountBytes = Uint8Array.from(
        addrEncoder.encode(feeAccountPda),
      );
      const payerBytes = Uint8Array.from(
        addrEncoder.encode(parseAddress(signer.getSignerAddress())),
      );

      const targetRouter = new Uint8Array(32); // H256::zero for Leaf/Routing
      const BATCH_SIZE = 25;
      let totalAdded = 0;
      let failedAt = -1;
      const baseTime = Math.floor(Date.now() / 1000);

      while (true) {
        const batchStart = totalAdded + 1;
        const batchEnd = totalAdded + BATCH_SIZE;
        let batchFailed = false;

        for (let i = batchStart; i <= batchEnd; i++) {
          // Unique recipient per quote
          const recipient = new Uint8Array(32);
          recipient[31] = i & 0xff;
          recipient[30] = (i >> 8) & 0xff;
          recipient[29] = (i >> 16) & 0xff;

          // Unique client_salt per quote
          const clientSalt = new Uint8Array(32);
          clientSalt[31] = i & 0xff;
          clientSalt[30] = (i >> 8) & 0xff;

          const quote = signStandingQuote({
            privKey: quoteSignerPrivKey,
            feeAccountPda: feeAccountBytes,
            domainId: DOMAIN_ID,
            destinationDomain: DEST_DOMAIN,
            recipient,
            amount: BigInt('18446744073709551615'), // u64::MAX for standing quotes
            maxFee: 1000n,
            halfAmount: 500n,
            issuedAt: baseTime,
            expiry: baseTime + 86400, // 24h from now
            clientSalt,
            payer: payerBytes,
          });

          try {
            const ix = await getSubmitStandingQuoteInstruction(
              programId,
              signer.signer.address,
              feeAccountPda,
              DEST_DOMAIN,
              targetRouter,
              quote,
              [], // Leaf mode: no route PDAs
              true, // fee_account writable for Leaf standing quotes
            );
            await signer.send({ instructions: [ix], skipPreflight: true });
          } catch (err) {
            console.log(
              `      SubmitStandingQuote(${i}): ✗ — ${(err as Error).message?.slice(0, 120)}`,
            );
            failedAt = i;
            batchFailed = true;
            break;
          }
        }

        if (batchFailed) break;
        totalAdded = batchEnd;
        console.log(
          `      SubmitStandingQuote batch [${batchStart}..${batchEnd}]: ✓ (total: ${totalAdded})`,
        );
      }

      const maxSuccess = failedAt > 0 ? failedAt - 1 : totalAdded;
      console.log(
        `\n    ► Max standing quotes per domain PDA (Leaf): ${maxSuccess} (failed at ${failedAt})`,
      );
    });

    // Discovered limit: 113 standing quotes per domain PDA (same as Leaf).
    // CC uses a non-zero target_router in PDA seeds and the fee account is
    // read-only, but the PDA structure and BTreeMap are identical.
    it('max standing quotes per domain PDA (CC routing)', async () => {
      const quoteSignerPrivKey = new Uint8Array(32);
      quoteSignerPrivKey[31] = 99;
      const quoteSignerH160 = privateKeyToH160(quoteSignerPrivKey);
      const quoteSignerHex =
        '0x' +
        Array.from(quoteSignerH160)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

      const { programAddress: programId } = await resolveProgram(
        { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
        signer,
        rpc,
      );

      const salt = deriveFeeSalt('stress-cc-standing-quotes');
      const DOMAIN_ID = 1;
      const DEST_DOMAIN = 10;
      const TARGET_ROUTER = new Uint8Array(32);
      TARGET_ROUTER[31] = 0xaa;

      // Init as CC routing
      const initIx = await getInitFeeInstruction(
        programId,
        signer.signer.address,
        {
          salt,
          beneficiary: parseAddress(signer.getSignerAddress()),
          feeData: {
            kind: FeeDataKind.CrossCollateralRouting,
            config: { wildcardSigners: [signerToH160(quoteSignerHex)] },
          },
          domainId: DOMAIN_ID,
        },
      );
      await signer.send({ instructions: [initIx], skipPreflight: true });

      const { address: feeAccountPda } = await deriveFeeAccountPda(
        programId,
        salt,
      );

      // Set a CC route so the signer is authorized for exact-domain quotes
      const { getSetCrossCollateralRouteInstruction } =
        await import('../instructions/fee.js');
      const setRouteIx = await getSetCrossCollateralRouteInstruction(
        programId,
        feeAccountPda,
        parseAddress(signer.getSignerAddress()),
        DEST_DOMAIN,
        TARGET_ROUTER,
        {
          kind: FeeStrategyKind.Linear,
          params: { maxFee: 1000n, halfAmount: 500n },
        },
        [signerToH160(quoteSignerHex)],
      );
      await signer.send({ instructions: [setRouteIx], skipPreflight: true });

      const { getAddressEncoder } = await import('@solana/kit');
      const addrEncoder = getAddressEncoder();
      const feeAccountBytes = Uint8Array.from(
        addrEncoder.encode(feeAccountPda),
      );
      const payerBytes = Uint8Array.from(
        addrEncoder.encode(parseAddress(signer.getSignerAddress())),
      );

      // Derive the CC route PDAs needed for SubmitQuote account list
      const { deriveCrossCollateralRoutePda } = await import('../pda.js');
      const { address: specificRoutePda } = await deriveCrossCollateralRoutePda(
        programId,
        feeAccountPda,
        DEST_DOMAIN,
        TARGET_ROUTER,
      );
      const defaultRouter = new Uint8Array(32).fill(0xff);
      const { address: defaultRoutePda } = await deriveCrossCollateralRoutePda(
        programId,
        feeAccountPda,
        DEST_DOMAIN,
        defaultRouter,
      );

      const BATCH_SIZE = 25;
      let totalAdded = 0;
      let failedAt = -1;
      const baseTime = Math.floor(Date.now() / 1000);

      while (true) {
        const batchStart = totalAdded + 1;
        const batchEnd = totalAdded + BATCH_SIZE;
        let batchFailed = false;

        for (let i = batchStart; i <= batchEnd; i++) {
          const recipient = new Uint8Array(32);
          recipient[31] = i & 0xff;
          recipient[30] = (i >> 8) & 0xff;
          recipient[29] = (i >> 16) & 0xff;

          const clientSalt = new Uint8Array(32);
          clientSalt[31] = i & 0xff;
          clientSalt[30] = (i >> 8) & 0xff;

          // CC quote context: dest_domain(4) + recipient(32) + amount(8) + target_router(32) = 76 bytes
          const context = Uint8Array.from(
            concatBytes(
              u32le(DEST_DOMAIN),
              recipient,
              u64le(BigInt('18446744073709551615')),
              TARGET_ROUTER,
            ),
          );
          const data = Uint8Array.from(concatBytes(u64le(1000n), u64le(500n)));

          const issuedAtBytes = u48be(baseTime);
          const expiryBytes = u48be(baseTime + 86400);
          const scopedSalt = computeScopedSalt(payerBytes, clientSalt);

          const messageHash = keccak_256(
            Uint8Array.from([
              ...DOMAIN_TAG,
              ...feeAccountBytes,
              ...new Uint8Array(new Uint32Array([DOMAIN_ID]).buffer),
              ...keccak_256(context),
              ...keccak_256(data),
              ...issuedAtBytes,
              ...expiryBytes,
              ...scopedSalt,
            ]),
          );

          const sig = secp256k1.sign(messageHash, quoteSignerPrivKey);
          const signature = new Uint8Array(65);
          signature.set(sig.toCompactRawBytes(), 0);
          signature[64] = sig.recovery;

          try {
            const ix = await getSubmitStandingQuoteInstruction(
              programId,
              signer.signer.address,
              feeAccountPda,
              DEST_DOMAIN,
              TARGET_ROUTER,
              {
                context,
                data,
                issuedAt: issuedAtBytes,
                expiry: expiryBytes,
                clientSalt,
                signature,
              },
              [specificRoutePda, defaultRoutePda],
              false, // fee_account read-only for CC standing quotes
            );
            await signer.send({ instructions: [ix], skipPreflight: true });
          } catch (err) {
            console.log(
              `      CC SubmitStandingQuote(${i}): ✗ — ${(err as Error).message?.slice(0, 120)}`,
            );
            failedAt = i;
            batchFailed = true;
            break;
          }
        }

        if (batchFailed) break;
        totalAdded = batchEnd;
        console.log(
          `      CC SubmitStandingQuote batch [${batchStart}..${batchEnd}]: ✓ (total: ${totalAdded})`,
        );
      }

      const maxSuccess = failedAt > 0 ? failedAt - 1 : totalAdded;
      console.log(
        `\n    ► Max standing quotes per domain PDA (CC): ${maxSuccess} (failed at ${failedAt})`,
      );
    });
  });
});
