import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import { getAddressCodec } from '@solana/kit';
import { assert, strip0x } from '@hyperlane-xyz/utils';

const ADDRESS_CODEC = getAddressCodec();

import {
  PROGRAM_INSTRUCTION_DISCRIMINATOR,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { ByteCursor, concatBytes, option, u8 } from '../codecs/binary.js';
import {
  decodeDomainedValidatorsAndThreshold,
  encodeDomainedValidatorsAndThreshold,
  type Domained,
  type H160,
  type ValidatorsAndThreshold,
} from '../codecs/shared.js';
import { isProgramInstructionDiscriminator } from './interfaces.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from './utils.js';
import {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
} from '../pda.js';

export enum MultisigIsmMessageIdProgramInstructionKind {
  Initialize = 0,
  SetValidatorsAndThreshold = 1,
  GetOwner = 2,
  TransferOwnership = 3,
}

export type MultisigIsmMessageIdProgramInstruction =
  | { kind: 'initialize' }
  | {
      kind: 'setValidatorsAndThreshold';
      value: Domained<ValidatorsAndThreshold>;
    }
  | { kind: 'getOwner' }
  | { kind: 'transferOwnership'; newOwner: Address | null };

export function encodeMultisigIsmMessageIdProgramInstruction(
  instruction: MultisigIsmMessageIdProgramInstruction,
): ReadonlyUint8Array {
  switch (instruction.kind) {
    case 'initialize':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(MultisigIsmMessageIdProgramInstructionKind.Initialize),
      );
    case 'setValidatorsAndThreshold':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(
          MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold,
        ),
        encodeDomainedValidatorsAndThreshold(instruction.value),
      );
    case 'getOwner':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(MultisigIsmMessageIdProgramInstructionKind.GetOwner),
      );
    case 'transferOwnership':
      return concatBytes(
        PROGRAM_INSTRUCTION_DISCRIMINATOR,
        u8(MultisigIsmMessageIdProgramInstructionKind.TransferOwnership),
        option(instruction.newOwner, (owner) => ADDRESS_CODEC.encode(owner)),
      );
  }
}

export function decodeMultisigIsmMessageIdProgramInstruction(
  data: Uint8Array,
): MultisigIsmMessageIdProgramInstruction | null {
  if (data.length < 9) return null;
  const cursor = new ByteCursor(data);
  cursor.readBytes(8);
  if (!isProgramInstructionDiscriminator(data)) return null;

  const kind = cursor.readU8();
  switch (kind) {
    case MultisigIsmMessageIdProgramInstructionKind.Initialize:
      return { kind: 'initialize' };
    case MultisigIsmMessageIdProgramInstructionKind.SetValidatorsAndThreshold:
      return {
        kind: 'setValidatorsAndThreshold',
        value: decodeDomainedValidatorsAndThreshold(cursor),
      };
    case MultisigIsmMessageIdProgramInstructionKind.GetOwner:
      return { kind: 'getOwner' };
    case MultisigIsmMessageIdProgramInstructionKind.TransferOwnership: {
      const hasOwner = cursor.readU8() === 1;
      return {
        kind: 'transferOwnership',
        newOwner: hasOwner ? ADDRESS_CODEC.decode(cursor.readBytes(32)) : null,
      };
    }
    default:
      if (
        kind <= MultisigIsmMessageIdProgramInstructionKind.TransferOwnership
      ) {
        throw new Error(
          `MultisigIsmMessageId instruction kind ${kind} is recognized but decoding is not yet implemented`,
        );
      }
      return null;
  }
}

/**
 * Measured hard limit on the validators of one origin domain: the most that fit
 * in a direct `SetValidatorsAndThreshold` transaction. A Squads
 * vault-transaction proposal wrapping it fits only 33 (31 with a
 * compute-unit-price instruction), with the default memo. See
 * {@link MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN} for the
 * measurement.
 */
export const ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_HARD_LIMIT = 45;

/**
 * Measured hard limit on the signatures of one Verify transaction (empty message
 * body, ISM accounts only). See
 * {@link MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD} for the measurement.
 */
export const ROUTING_MESSAGE_ID_MULTISIG_SIGNATURES_HARD_LIMIT = 12;

/**
 * Enforced cap on the validators of one origin domain of a
 * `routingMessageIdMultisigIsm`.
 *
 * Measured hard limits (bundled multisig-ism-message-id program, local test
 * validator, 2026-09-30; reproduced by
 * `routing-message-id-multisig-ism-limits.e2e-test.ts`):
 * - `SetValidatorsAndThreshold` is one transaction carrying 20 bytes per
 *   validator. With the compute-budget instruction it is 1230 bytes at 45
 *   validators and 1250 at 46, against Solana's 1232-byte limit, so 45 is the
 *   hard limit (44 when a compute-unit-price instruction is also added).
 * - The domain account starts at 1024 bytes (7 + 20n bytes needed), i.e. 50
 *   validators, and grows without a lamport top-up above that. This wall is
 *   unreachable in a single transaction, so it does not bind first.
 * - Verifying deserializes the whole set at about 55 compute units per
 *   validator (about 2.4k units at 45), which is negligible.
 *
 * - Wrapped in a Squads vault-transaction proposal (the repo's
 *   `buildSquadsVaultTransactionProposal` in infra/src/utils/squads.ts bundles
 *   `vaultTransactionCreate` and `proposalCreate` in one transaction), the same
 *   instruction adds about 238 bytes. Measured 2026-10-01 with the real
 *   `@sqds/multisig` builders, direct / Squads-bundled bytes: N=20: 730/968,
 *   N=30: 930/1168, N=35: 1030/1268, N=40: 1130/1368, N=45: 1230/1468. Only 33
 *   validators fit (31 with a compute-unit-price instruction). Multi-domain
 *   batches are chunked with
 *   {@link ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES} so they
 *   fit both forms.
 *
 * At most 12 validators (signatures) can verify a message in one execution
 * ({@link ROUTING_MESSAGE_ID_MULTISIG_SIGNATURES_HARD_LIMIT}; the enforced
 * threshold cap stays 8). The cap is 24, twice that: a deliberately
 * conservative practical cap, well below the actual hard limits above (45
 * direct, 33 Squads-wrapped). It can be raised later up to those limits; above
 * 33 only with buffered Squads proposals, which the repo does not support.
 */
export const MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN = 24;

/**
 * Bytes reserved per `SetValidatorsAndThreshold` batch so that the batch also
 * fits a Squads vault-transaction proposal. The proposal wraps the batch in an
 * inner message and bundles `vaultTransactionCreate` and `proposalCreate` in
 * one legacy transaction (`buildSquadsVaultTransactionProposal` in
 * typescript/infra/src/utils/squads.ts), with a compute-unit-price instruction
 * prepended (`buildTransaction` in
 * typescript/sdk/src/signers/svm/solana-web3js.ts).
 *
 * Measured 2026-10-01 with the real `@sqds/multisig` builders: the wrapped
 * transaction minus the direct transaction (compute-budget instruction
 * included) is at most 294 bytes with the 29-byte default memo, over batches of
 * 1 to 45 domains with 1 to 45 validators each (worst case 12 domains of 1
 * validator, with the compute-unit-price instruction), and grows by 1 byte per
 * memo character: 329 at the 64-character memo of
 * `submitReceiptTxsToSquads` callers (typescript/infra/scripts/squads/propose-warp-batch.ts,
 * "Hyperlane warp apply batch (N tx) for <chain> (i/N)"). 340 covers memos of
 * up to 75 characters; a longer memo can overflow a batch that fills the
 * reservation. A 24-validator domain (the enforced cap) is 809 bytes direct and
 * always fits alone.
 *
 * Trade-off: direct submissions use slightly more transactions than the 1232
 * byte limit alone would need.
 */
export const ROUTING_MESSAGE_ID_MULTISIG_SQUADS_WRAPPING_RESERVED_BYTES = 340;

/**
 * Enforced cap on the threshold of one origin domain of a
 * `routingMessageIdMultisigIsm`.
 *
 * Measured (same method as
 * {@link MAX_ROUTING_MESSAGE_ID_MULTISIG_VALIDATORS_PER_DOMAIN}):
 * - Verification recovers one secp256k1 signer per threshold signature at
 *   about 25.4k compute units each on top of about 53k fixed units
 *   (T=1: 78.6k, T=5: 180k, T=10: 307k, T=12: 358k). The default 200k
 *   per-instruction limit only fits T<=5; the 1.4M maximum would fit T<=53, so
 *   compute is not the binding limit.
 * - The metadata carries 65 bytes per signature, so the Verify transaction is
 *   the binding limit: at most 12 signatures fit a single packet, with an
 *   empty message body and only the ISM accounts. The mailbox `process`
 *   transaction also carries the recipient accounts and the message body, so
 *   fewer fit there (address lookup tables recover only the account bytes).
 *
 * The cap is 8, leaving 4 signatures (260 bytes) below the Verify-only hard
 * limit for that overhead. A higher threshold can make every message
 * undeliverable, which is why it is rejected instead of accepted.
 */
export const MAX_ROUTING_MESSAGE_ID_MULTISIG_THRESHOLD = 8;

export interface SetDomainValidatorsArgs {
  programAddress: Address;
  owner: Address;
  domain: number;
  validators: readonly (H160 | string)[];
  threshold: number;
}

/**
 * Fails with AlreadyInitialized on an initialized access-control PDA, so
 * writers check the account first.
 *
 * Accounts (mirrors `init_instruction` in
 * rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs):
 * 0. [signer, writable] owner and payer of the access-control PDA
 * 1. [writable] access-control PDA
 * 2. [] system program
 */
export async function getInitializeMultisigIsmMessageIdInstruction(
  programAddress: Address,
  owner: TransactionSigner,
): Promise<Instruction> {
  const { address: accessControl } =
    await deriveMultisigIsmAccessControlPda(programAddress);
  return buildInstruction(
    programAddress,
    [
      writableSigner(owner),
      writableAccount(accessControl),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeMultisigIsmMessageIdProgramInstruction({ kind: 'initialize' }),
  );
}

/**
 * Accounts (mirrors `set_validators_and_threshold` in
 * rust/sealevel/programs/ism/multisig-ism-message-id/src/processor.rs):
 * 0. [signer, writable] owner, and payer of the domain PDA
 * 1. [] access-control PDA
 * 2. [writable] domain PDA
 * 3. [] system program, required only when creating the domain PDA (a set
 *    without it is rejected while the domain PDA does not exist); always
 *    passed here so one builder serves create and update.
 *
 * The validators are stored in the given order, which is load-bearing for
 * verification (signatures must follow it).
 */
export async function getSetValidatorsAndThresholdInstruction(
  args: SetDomainValidatorsArgs,
): Promise<Instruction> {
  const { address: accessControl } = await deriveMultisigIsmAccessControlPda(
    args.programAddress,
  );
  const { address: domainData } = await deriveMultisigIsmDomainDataPda(
    args.programAddress,
    args.domain,
  );
  const validators = args.validators.map((v) =>
    typeof v === 'string' ? hexToBytes20(v) : v,
  );
  return buildInstruction(
    args.programAddress,
    [
      writableSignerAddress(args.owner),
      readonlyAccount(accessControl),
      writableAccount(domainData),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeMultisigIsmMessageIdProgramInstruction({
      kind: 'setValidatorsAndThreshold',
      value: {
        domain: args.domain,
        data: {
          validators,
          threshold: args.threshold,
        },
      },
    }),
  );
}

/**
 * Accounts: 0. [signer, writable] current owner, 1. [writable] access-control
 * PDA. The PDA is writable although the program's `Instruction` enum doc lists
 * it as `[]`: `transfer_ownership` stores the new owner into it
 * (rust/sealevel/programs/ism/multisig-ism-message-id/src/processor.rs).
 * A null `newOwner` renounces ownership.
 */
export async function getTransferOwnershipInstruction(
  programAddress: Address,
  owner: Address,
  newOwner: Address | null,
): Promise<Instruction> {
  const { address: accessControl } =
    await deriveMultisigIsmAccessControlPda(programAddress);
  return buildInstruction(
    programAddress,
    [writableSignerAddress(owner), writableAccount(accessControl)],
    encodeMultisigIsmMessageIdProgramInstruction({
      kind: 'transferOwnership',
      newOwner,
    }),
  );
}

function hexToBytes20(value: string): Uint8Array {
  const hex = strip0x(value);
  assert(
    /^[0-9a-fA-F]{40}$/.test(hex),
    `Expected 20-byte hex validator, got ${value}`,
  );
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
