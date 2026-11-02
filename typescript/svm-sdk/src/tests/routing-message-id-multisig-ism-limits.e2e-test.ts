import {
  AccountRole,
  type Address,
  type Instruction,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes } from '@noble/hashes/utils';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { encodeInterchainSecurityModuleInterfaceInstruction } from '../instructions/interfaces.js';
import {
  MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD,
  MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
  getSetValidatorsAndThresholdInstruction,
} from '../instructions/multisig-ism-message-id.js';
import { SvmRoutingMessageIdMultisigIsmWriter } from '../ism/multisig-ism.js';
import { deriveMultisigIsmDomainDataPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import {
  SOLANA_MAX_TRANSACTION_SIZE,
  estimateTransactionWireSize,
  getComputeBudgetInstructions,
} from '../tx.js';

/**
 * Limits of the Sealevel routing message-id multisig ISM program (one
 * domain-data PDA per origin domain), measured against the bundled program on
 * a local test validator on 2026-09-30. Numbers are recorded here and logged
 * on every run; assertions only pin coarse invariants, never exact CU values.
 *
 * Method
 * - Set time: real `SetValidatorsAndThreshold` transactions sent through
 *   `SvmSigner` for increasing validator counts, plus the serialized size the
 *   transaction would have (`estimateTransactionWireSize`, which includes the
 *   compute-budget instruction `SvmSigner.send()` always prepends).
 * - Verify time: the ISM interface `Verify` instruction (accounts: the
 *   readonly domain-data PDA) simulated with `simulateTransaction` and a
 *   1_400_000 compute-unit limit; `unitsConsumed` is recorded. Metadata is
 *   `MultisigIsmMessageIdMetadata` (hook | root | index u32 BE | 65-byte
 *   signatures) signed over the EIP-191 hash of
 *   keccak(domainHash | root | index | messageId), as the Rust
 *   `CheckpointWithMessageId` does. Signatures are ordered by the on-chain
 *   validator order, as `MultisigIsm::verify` requires.
 *
 * Findings (see the `MAX_ROUTING_MESSAGE_ID_MULTISIG_*` constants in
 * instructions/multisig-ism-message-id.ts for the enforced caps: 24 validators,
 * threshold 8)
 *
 * | Limit                                   | Measured                          |
 * | --------------------------------------- | --------------------------------- |
 * | Set tx size, 40 / 45 / 46 / 50 / 60 val | 1130 / 1230 / 1250 / 1330 / 1530 B |
 * | Set tx size limit                       | 1232 B -> max 45 validators       |
 * | Domain account (7 + 20n bytes, 1024 B)  | 50 validators (not reachable)     |
 * | Verify, N=45: T=1 / 2 / 5 / 10 / 12     | 78.6k / 104k / 180k / 307k / 358k CU |
 * | Verify, N=1 / 10 / 33 at T=1            | 76.2k / 76.7k / 78.0k CU          |
 * | Verify per extra signature              | about 25.4k CU (one secp256k1 recovery) |
 * | Verify fixed cost                       | about 53k CU                      |
 * | Verify per configured validator         | about 55 CU                       |
 * | Verify tx size (empty body, ISM only)   | max 12 signatures in 1232 B       |
 *
 * - Set time: a single `SetValidatorsAndThreshold` transaction (with the
 *   compute-budget instruction) is 1230 bytes at 45 validators and 1250 at 46,
 *   against the 1232-byte limit; `SvmSigner` rejects the 46-validator set with
 *   "Transaction size 1250 exceeds limit of 1232 bytes". 45 is the hard limit
 *   (44 with a compute-unit-price instruction). The domain account is created
 *   at 1024 bytes, which holds 50 validators (7 + 20n); above that `store()`
 *   grows it by 1024 bytes without a lamport top-up. That wall (and the
 *   51/60-validator behaviour, including re-setting an existing PDA to a
 *   larger set) could NOT be measured: no transaction can carry more than 45
 *   validators, so it is derived from the Rust source only.
 * - Verify time: cost is driven by the on-chain threshold, one secp256k1
 *   recovery (about 25.4k CU) per signature on top of about 53k CU fixed;
 *   deserializing the whole set costs about 55 CU per validator. The default
 *   200k limit fits T<=5, the 1.4M maximum would fit T<=53 (linear model,
 *   extrapolated), so compute is not the binding limit.
 * - The binding verify limit is the packet: the metadata carries 65 bytes per
 *   signature, so a Verify transaction fits at most 12 signatures (empty
 *   message body, only the domain account). The mailbox `process` transaction
 *   also carries the recipient accounts and the message body, so it fits fewer
 *   (assumption, not measured: a warp message body adds 64+ bytes and every
 *   extra account 32 bytes, or 1 byte through an address lookup table).
 * - Not measured: a real mailbox `process` transaction.
 */
const VERIFY_CU_LIMIT = 1_400_000;
const VERIFY_DEFAULT_CU_LIMIT = 200_000;
const MEASURED_MAX_VALIDATORS_PER_TRANSACTION = 45;

const logger = rootLogger.child({ module: 'routing-multisig-limits' });

const HEX_BYTE = 2;

const u32be = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
};

const bytesOf = (length: number, fill: (index: number) => number) =>
  Uint8Array.from({ length }, (_, i) => fill(i));

const toHex = (bytes: Uint8Array): string =>
  '0x' +
  Array.from(bytes, (b) => b.toString(16).padStart(HEX_BYTE, '0')).join('');

/** Deterministic secp256k1 private key #index (32 bytes, big-endian). */
const privateKeyFor = (index: number): Uint8Array =>
  concatBytes(new Uint8Array(28), u32be(index + 1));

const validatorAddressOf = (privateKey: Uint8Array): string => {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return toHex(keccak_256(publicKey.slice(1)).slice(12));
};

interface SignedVerifyFixture {
  metadata: Uint8Array;
  message: Uint8Array;
}

const HOOK = bytesOf(32, (i) => 0xa0 + (i % 16));
const ROOT = bytesOf(32, (i) => 0xb0 + (i % 16));
const MERKLE_INDEX = 7;
const SENDER = bytesOf(32, (i) => 0xc0 + (i % 16));
const RECIPIENT = bytesOf(32, (i) => 0xd0 + (i % 16));

function buildMessage(origin: number): Uint8Array {
  return concatBytes(
    Uint8Array.of(3),
    u32be(1),
    u32be(origin),
    SENDER,
    u32be(TEST_SVM_CHAIN_METADATA.domainId),
    RECIPIENT,
  );
}

/** Metadata + message signed by `signerKeys` (in the given order). */
function buildVerifyFixture(
  origin: number,
  signerKeys: Uint8Array[],
): SignedVerifyFixture {
  const message = buildMessage(origin);
  const messageId = keccak_256(message);
  const domainHash = keccak_256(
    concatBytes(u32be(origin), HOOK, new TextEncoder().encode('HYPERLANE')),
  );
  const signingHash = keccak_256(
    concatBytes(domainHash, ROOT, u32be(MERKLE_INDEX), messageId),
  );
  const ethSignedHash = keccak_256(
    concatBytes(
      new TextEncoder().encode('\x19Ethereum Signed Message:\n32'),
      signingHash,
    ),
  );
  const signatures = signerKeys.map((key) => {
    const sig = secp256k1.sign(ethSignedHash, key);
    return concatBytes(sig.toCompactRawBytes(), Uint8Array.of(sig.recovery));
  });
  return {
    metadata: concatBytes(HOOK, ROOT, u32be(MERKLE_INDEX), ...signatures),
    message,
  };
}

// Error::ThresholdNotMet = 7 in
// rust/sealevel/programs/ism/multisig-ism-message-id/src/error.rs
const THRESHOLD_NOT_MET_LOG = 'custom program error: 0x7';

interface SimulationResult {
  err: unknown;
  unitsConsumed: bigint | undefined;
  logs: readonly string[];
}

describe('SVM routing message-id multisig ISM limits (measurements)', function () {
  this.timeout(280_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programId: Address;
  let nextDomain = 1000;

  const simulate = async (
    instruction: Instruction,
    payer: Address,
  ): Promise<SimulationResult> => {
    const message = appendTransactionMessageInstructions(
      [...getComputeBudgetInstructions(VERIFY_CU_LIMIT), instruction],
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash('11111111111111111111111111111111'),
          lastValidBlockHeight: 0n,
        },
        setTransactionMessageFeePayer(
          payer,
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const wire = getBase64EncodedWireTransaction(compileTransaction(message));
    const { value } = await rpc
      .simulateTransaction(wire, {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
      .send();
    return {
      err: value.err,
      unitsConsumed: value.unitsConsumed,
      logs: value.logs ?? [],
    };
  };

  const setDomain = async (
    validatorCount: number,
    threshold: number,
  ): Promise<{ domain: number; keys: Uint8Array[] }> => {
    const domain = nextDomain++;
    const keys = Array.from({ length: validatorCount }, (_, i) =>
      privateKeyFor(i),
    );
    await signer.send({
      instructions: [
        await getSetValidatorsAndThresholdInstruction({
          programAddress: programId,
          owner: signer.signer.address,
          domain,
          validators: keys.map(validatorAddressOf),
          threshold,
        }),
      ],
    });
    return { domain, keys };
  };

  const verifyInstruction = async (
    domain: number,
    keys: Uint8Array[],
    signatureCount: number,
  ): Promise<Instruction> => {
    const { metadata, message } = buildVerifyFixture(
      domain,
      keys.slice(0, signatureCount),
    );
    const { address: domainPda } = await deriveMultisigIsmDomainDataPda(
      programId,
      domain,
    );
    return {
      programAddress: programId,
      accounts: [{ address: domainPda, role: AccountRole.READONLY }],
      data: encodeInterchainSecurityModuleInterfaceInstruction({
        type: 'verify',
        data: { metadata, message },
      }),
    };
  };

  const verifyUnits = async (
    domain: number,
    keys: Uint8Array[],
    signatureCount: number,
  ): Promise<SimulationResult> =>
    simulate(
      await verifyInstruction(domain, keys, signatureCount),
      signer.signer.address,
    );

  const maxVerifySignatures = async (
    domain: number,
    keys: Uint8Array[],
  ): Promise<number> => {
    let fits = 0;
    for (let count = 1; count <= keys.length; count++) {
      const size = estimateTransactionWireSize(signer.signer.address, [
        await verifyInstruction(domain, keys, count),
      ]);
      if (size > SOLANA_MAX_TRANSACTION_SIZE) break;
      fits = count;
    }
    return fits;
  };

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      TEST_SVM_CHAIN_METADATA,
      '0x' + '1'.padStart(64, '0'),
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 40_000_000_000n);

    const writer = new SvmRoutingMessageIdMultisigIsmWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.multisigIsm } },
      rpc,
      signer,
      [1],
    );
    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: 'routingMessageIdMultisigIsm',
        owner: signer.signer.address,
        domains: {},
      },
    });
    programId = deployed.deployed.programId;
  });

  describe('set time', () => {
    const wireSize = async (validatorCount: number): Promise<number> =>
      estimateTransactionWireSize(signer.signer.address, [
        await getSetValidatorsAndThresholdInstruction({
          programAddress: programId,
          owner: signer.signer.address,
          domain: 1,
          validators: Array.from({ length: validatorCount }, (_, i) =>
            validatorAddressOf(privateKeyFor(i)),
          ),
          threshold: 1,
        }),
      ]);

    it('fits at most 45 validators in one transaction', async () => {
      const sizes: Record<number, number> = {};
      for (const count of [40, 45, 46, 50, 51, 60]) {
        sizes[count] = await wireSize(count);
      }
      logger.info({ sizes }, 'set-time transaction wire sizes by validators');
      expect(sizes[MEASURED_MAX_VALIDATORS_PER_TRANSACTION]).to.be.at.most(
        SOLANA_MAX_TRANSACTION_SIZE,
      );
      expect(
        sizes[MEASURED_MAX_VALIDATORS_PER_TRANSACTION + 1],
      ).to.be.greaterThan(SOLANA_MAX_TRANSACTION_SIZE);
    });

    it('lands a set at the measured transaction-size maximum', async () => {
      const { domain } = await setDomain(
        MEASURED_MAX_VALIDATORS_PER_TRANSACTION,
        1,
      );
      const { address: domainPda } = await deriveMultisigIsmDomainDataPda(
        programId,
        domain,
      );
      const account = await rpc
        .getAccountInfo(domainPda, {
          encoding: 'base64',
          commitment: 'confirmed',
        })
        .send();
      assert(account.value, `Domain PDA for ${domain} not created`);
      logger.info(
        { dataLength: account.value.data[0].length },
        'domain PDA base64 length at the maximum set',
      );
      expect(account.value.owner).to.equal(programId);
    });

    it('rejects a set above the measured transaction-size maximum', async () => {
      let message = '';
      try {
        await setDomain(MEASURED_MAX_VALIDATORS_PER_TRANSACTION + 1, 1);
      } catch (err: unknown) {
        assert(err instanceof Error, 'expected an Error rejection');
        message = err.message;
      }
      logger.info({ message }, 'error observed for an oversized set');
      expect(message).to.contain('exceeds limit');
    });

    it('enforced validator cap is below the measured maximum', () => {
      expect(
        MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN,
      ).to.be.lessThan(MEASURED_MAX_VALIDATORS_PER_TRANSACTION);
    });
  });

  describe('verify time', () => {
    it('accepts a correctly signed message and rejects outsiders and too few signatures', async () => {
      const { domain, keys } = await setDomain(3, 2);
      const ok = await verifyUnits(domain, keys, 2);
      expect(ok.err, ok.logs.join('\n')).to.equal(null);

      const outsider = await verifyUnits(
        domain,
        [privateKeyFor(50), privateKeyFor(51)],
        2,
      );
      expect(outsider.logs.join('\n')).to.contain(THRESHOLD_NOT_MET_LOG);

      const tooFew = await verifyUnits(domain, keys, 1);
      expect(tooFew.logs.join('\n')).to.contain(THRESHOLD_NOT_MET_LOG);
    });

    it('measures compute units by threshold and validator count', async () => {
      const rows: string[] = [];
      const units = new Map<string, number>();

      const measure = async (
        setId: { domain: number; keys: Uint8Array[] },
        validatorCount: number,
        threshold: number,
      ) => {
        const result = await verifyUnits(setId.domain, setId.keys, threshold);
        expect(result.err, result.logs.join('\n')).to.equal(null);
        assert(result.unitsConsumed !== undefined, 'no unitsConsumed');
        const consumed = Number(result.unitsConsumed);
        units.set(`${validatorCount}/${threshold}`, consumed);
        rows.push(`N=${validatorCount} T=${threshold} CU=${consumed}`);
      };

      // The Verify transaction carries 65 bytes per signature, so the
      // threshold that can be simulated at all is bounded by the packet size.
      // The program recovers exactly `threshold` signers (the on-chain
      // threshold, not the number of signatures supplied), so every threshold
      // needs its own configured domain.
      const largest = await setDomain(
        MEASURED_MAX_VALIDATORS_PER_TRANSACTION,
        1,
      );
      const maxThreshold = await maxVerifySignatures(
        largest.domain,
        largest.keys,
      );
      logger.info(
        { maxThreshold },
        'largest threshold whose Verify transaction fits in one packet',
      );
      expect(maxThreshold).to.be.greaterThan(5);
      expect(MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD).to.be.lessThan(
        maxThreshold,
      );
      expect(maxThreshold).to.be.lessThan(
        MEASURED_MAX_VALIDATORS_PER_TRANSACTION,
      );

      for (const threshold of [1, 2, 5, 10, maxThreshold]) {
        await measure(
          await setDomain(MEASURED_MAX_VALIDATORS_PER_TRANSACTION, threshold),
          MEASURED_MAX_VALIDATORS_PER_TRANSACTION,
          threshold,
        );
      }
      for (const count of [1, 5, 10, 20, 33]) {
        await measure(await setDomain(count, 1), count, 1);
      }
      for (const count of [5, 10, 20]) {
        const threshold = Math.min(Math.ceil((2 * count) / 3), maxThreshold);
        await measure(await setDomain(count, threshold), count, threshold);
      }
      logger.info(`verify compute units:\n${rows.join('\n')}`);

      const at = (key: string): number => {
        const value = units.get(key);
        assert(value !== undefined, `Missing measurement ${key}`);
        return value;
      };
      const perSignature =
        (at(`45/${maxThreshold}`) - at('45/1')) / (maxThreshold - 1);
      const base = at('45/1') - perSignature;
      const budget = (limit: number) =>
        Math.floor((limit - base) / perSignature);
      logger.info(
        {
          perSignatureUnits: perSignature,
          baseUnits: base,
          thresholdAtDefaultLimit: budget(VERIFY_DEFAULT_CU_LIMIT),
          thresholdAtMaxLimit: budget(VERIFY_CU_LIMIT),
        },
        'linear model of verify cost (extrapolated beyond the packet limit)',
      );

      // One secp256k1 recovery per signature dominates; the validator count
      // alone (threshold 1) costs much less than a signature.
      expect(at(`45/${maxThreshold}`)).to.be.greaterThan(at('45/5'));
      expect(at('45/5')).to.be.greaterThan(at('45/1'));
      expect(at('45/1') - at('1/1')).to.be.lessThan(perSignature);
    });
  });
});
