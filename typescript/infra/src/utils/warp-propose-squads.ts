import { AccountRole, isSignerRole, isWritableRole } from '@solana/kit';
import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType, eqAddressSol } from '@hyperlane-xyz/utils';

// Filename pattern produced by AltVMFileSubmitter via `hyperlane warp apply`'s
// default file-submitter naming: `<chain>-file-<timestamp>-receipts.json`.
export const RECEIPT_FILENAME_RE = /^([a-z0-9_-]+)-file-\d+-receipts\.json$/i;

// Shape of the entries in a `PrintableSvmTransaction`'s expanded
// `instructions[]`, produced by SvmSigner.transactionToPrintableJson in
// svm-sdk (typescript/svm-sdk/src/clients/signer.ts). `programAddress` and
// each account `address` are base58 pubkeys; `role` is @solana/kit's numeric
// `AccountRole` (READONLY=0, WRITABLE=1, READONLY_SIGNER=2,
// WRITABLE_SIGNER=3); `data` is hex-encoded instruction data.
export const PrintableSvmInstructionSchema = z.object({
  programAddress: z.string(),
  accounts: z
    .array(
      z.object({
        address: z.string(),
        role: z.number().int(),
      }),
    )
    .optional(),
  data: z.string().optional(),
});

export type PrintableSvmInstruction = z.infer<
  typeof PrintableSvmInstructionSchema
>;

// Shape produced by SvmSigner.transactionToPrintableJson in svm-sdk. Beyond
// the canonical wire bytes (`transaction_base58`) we read the expanded
// `instructions[]` (the rehydration source — see `buildInstructionsFromPrintable`),
// `waitForSlotAdvance` (the execution-ordering barrier for dependent multi-tx
// receipts such as program deploys, rejected by `assertSimpleReceipt`), and
// `computeUnits` (carried through to the Squads proposal for the executor to
// apply at `vaultTransactionExecute`). Passthrough keeps any additional
// writer fields.
export const PrintableSvmTransactionSchema = z
  .object({
    transaction_base58: z.string(),
    instructions: z.array(PrintableSvmInstructionSchema).min(1),
    waitForSlotAdvance: z.boolean().optional(),
    computeUnits: z.number().optional(),
  })
  .passthrough();

export type PrintableSvmTransaction = z.infer<
  typeof PrintableSvmTransactionSchema
>;

export const ReceiptFileSchema = z.array(PrintableSvmTransactionSchema).min(1);

export type ParsedReceipt = {
  chain: ChainName;
  txs: z.infer<typeof ReceiptFileSchema>;
};

/**
 * A single source transaction rehydrated into its own Squads vault-transaction
 * proposal. Only the simple case reaches this point: receipts needing
 * execution-time slot ordering are rejected upstream by `assertSimpleReceipt`,
 * since the proposer cannot enforce that at execution time. `computeUnits` is
 * carried through for the external executor to apply at
 * `vaultTransactionExecute`.
 */
export type ReceiptProposalPlan = {
  instructions: TransactionInstruction[];
  computeUnits?: number;
};

export function parseFilename(
  filename: string,
): { chain: ChainName } | { error: string } {
  const match = filename.match(RECEIPT_FILENAME_RE);
  if (!match) {
    return {
      error: `Filename does not match <chain>-file-<timestamp>-receipts.json`,
    };
  }
  return { chain: match[1] };
}

/**
 * Type guard narrowing a raw numeric role (untrusted receipt JSON) to
 * `@solana/kit`'s `AccountRole` enum.
 */
function isAccountRole(role: number): role is AccountRole {
  return (
    role === AccountRole.READONLY ||
    role === AccountRole.WRITABLE ||
    role === AccountRole.READONLY_SIGNER ||
    role === AccountRole.WRITABLE_SIGNER
  );
}

/**
 * Rebuilds legacy `TransactionInstruction[]` from a receipt's expanded
 * `instructions[]` (produced by SvmSigner.transactionToPrintableJson in
 * svm-sdk). This is the ALT-safe rehydration path: account pubkeys are taken
 * directly from the writer's expanded list instead of being resolved from
 * the wire's address-lookup-table indexes, which cannot be done offline for
 * ALT-loaded accounts. Callers MUST first validate the receipt against the
 * wire with `validateInstructionsAgainstWire`, which cross-checks every
 * account it can (identity for static keys, role/writability for all).
 */
export function buildInstructionsFromPrintable(
  printableIxs: readonly PrintableSvmInstruction[],
): TransactionInstruction[] {
  return printableIxs.map((ix) => {
    const keys = (ix.accounts ?? []).map((account) => {
      if (!isAccountRole(account.role)) {
        throw new Error(
          `Unknown AccountRole ${account.role} for account ${account.address}`,
        );
      }
      return {
        pubkey: new PublicKey(account.address),
        isSigner: isSignerRole(account.role),
        isWritable: isWritableRole(account.role),
      };
    });
    return new TransactionInstruction({
      programId: new PublicKey(ix.programAddress),
      keys,
      data: ix.data ? Buffer.from(ix.data, 'hex') : Buffer.alloc(0),
    });
  });
}

/**
 * Validates a receipt's expanded `instructions[]` against the canonical wire
 * payload (`transaction_base58`) before rehydrating from it. Instruction
 * count/order, `programAddress`, `data`, and per-instruction account count
 * are all resolvable from the wire without ALT lookups and are checked here.
 * Account PUBKEY identity is also checked for every account that indexes
 * into the wire's static key list — the common case for warp
 * owner/config-update instructions, which carry no ALT; a genuinely
 * ALT-loaded account's pubkey cannot be verified offline (its address lives
 * on-chain, not in the wire), which is exactly why `buildInstructionsFromPrintable`
 * takes it from the writer's expanded instructions rather than the wire. Every
 * account's role is also checked against the wire (via
 * `Message(V0).isAccountSigner`/`isAccountWritable`), but only in the
 * direction that matters: the receipt may not CLAIM a stronger role
 * (signer/writable) than the wire grants — see the inline comment below for
 * why the reverse (wire stronger than receipt) is expected and tolerated.
 * Throws a specific error (instruction/account index + reason) on any
 * mismatch.
 */
export function validateInstructionsAgainstWire(
  printableIxs: readonly PrintableSvmInstruction[],
  transactionBase58: string,
): void {
  const bytes = bs58.decode(transactionBase58);
  const { message } = VersionedTransaction.deserialize(bytes);

  if (message.compiledInstructions.length !== printableIxs.length) {
    throw new Error(
      `Receipt instructions do not match wire payload: wire has ${message.compiledInstructions.length} instruction(s), receipt has ${printableIxs.length}`,
    );
  }

  // Total accounts the wire message resolves to offline: static keys plus
  // every ALT-loaded index declared in addressTableLookups (whose pubkeys are
  // not resolvable offline, but whose count and writable/readonly split are).
  const totalAccountKeys =
    message.staticAccountKeys.length +
    message.addressTableLookups.reduce(
      (sum, lookup) =>
        sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
      0,
    );

  printableIxs.forEach((printableIx, index) => {
    const compiled = message.compiledInstructions[index];

    if (compiled.programIdIndex >= message.staticAccountKeys.length) {
      throw new Error(
        `Receipt instructions do not match wire payload: instruction ${index} programIdIndex ${compiled.programIdIndex} is out of range of the wire's static account keys`,
      );
    }
    const wireProgramAddress =
      message.staticAccountKeys[compiled.programIdIndex].toBase58();
    if (wireProgramAddress !== printableIx.programAddress) {
      throw new Error(
        `Receipt instructions do not match wire payload: instruction ${index} programAddress mismatch (wire=${wireProgramAddress}, receipt=${printableIx.programAddress})`,
      );
    }

    const wireData = Buffer.from(compiled.data);
    const receiptData = printableIx.data
      ? Buffer.from(printableIx.data, 'hex')
      : Buffer.alloc(0);
    if (!wireData.equals(receiptData)) {
      throw new Error(
        `Receipt instructions do not match wire payload: instruction ${index} data mismatch`,
      );
    }

    const receiptAccounts = printableIx.accounts ?? [];
    if (receiptAccounts.length !== compiled.accountKeyIndexes.length) {
      throw new Error(
        `Receipt instructions do not match wire payload: instruction ${index} has ${receiptAccounts.length} account(s), wire has ${compiled.accountKeyIndexes.length}`,
      );
    }

    compiled.accountKeyIndexes.forEach((keyIndex, accountIndex) => {
      if (keyIndex >= totalAccountKeys) {
        throw new Error(
          `Receipt instructions do not match wire payload: instruction ${index} account ${accountIndex} key index ${keyIndex} is out of range of the wire's resolved account keys`,
        );
      }

      const receiptAccount = receiptAccounts[accountIndex];
      if (!isAccountRole(receiptAccount.role)) {
        throw new Error(
          `Receipt instructions do not match wire payload: instruction ${index} account ${accountIndex} has unknown AccountRole ${receiptAccount.role}`,
        );
      }

      // The wire's per-index role is a message-level OR-merge across every
      // instruction that references the account, PLUS the fee payer is
      // unconditionally forced to signer+writable (a base Solana protocol
      // rule — account index 0 is always the fee payer). So a single
      // instruction's declared role can legitimately be WEAKER than the
      // wire's resolved role for the same account (e.g. a warp
      // config-update's owner is a readonly signer at the instruction level,
      // but is also the tx's fee payer, so the wire resolves it writable).
      // What must never happen is the receipt CLAIMING a role stronger than
      // the wire actually grants — that would let a tampered receipt request
      // more authority over the (identity-checked) account than the
      // simulated wire authorized.
      const wireIsSigner = message.isAccountSigner(keyIndex);
      const wireIsWritable = message.isAccountWritable(keyIndex);
      const receiptIsSigner = isSignerRole(receiptAccount.role);
      const receiptIsWritable = isWritableRole(receiptAccount.role);
      if (receiptIsSigner && !wireIsSigner) {
        throw new Error(
          `Receipt instructions do not match wire payload: instruction ${index} account ${accountIndex} claims signer but wire does not grant it`,
        );
      }
      if (receiptIsWritable && !wireIsWritable) {
        throw new Error(
          `Receipt instructions do not match wire payload: instruction ${index} account ${accountIndex} claims writable but wire does not grant it`,
        );
      }

      // Pubkey identity is only resolvable offline for static keys; an
      // ALT-loaded index's address lives on-chain and cannot be verified
      // here (role/writability above is the full check available for those).
      if (keyIndex < message.staticAccountKeys.length) {
        const wireAddress = message.staticAccountKeys[keyIndex].toBase58();
        if (wireAddress !== receiptAccount.address) {
          throw new Error(
            `Receipt instructions do not match wire payload: instruction ${index} account ${accountIndex} address mismatch (wire=${wireAddress}, receipt=${receiptAccount.address})`,
          );
        }
      }
    });
  });
}

export function parseReceiptFile(
  filePath: string,
  mpp: MultiProtocolProvider,
): ParsedReceipt | { error: string } {
  const filename = path.basename(filePath);
  const parsedName = parseFilename(filename);
  if ('error' in parsedName) {
    return parsedName;
  }
  const { chain } = parsedName;

  let protocol: ProtocolType;
  try {
    protocol = mpp.getProtocol(chain);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unknown chain ${chain}: ${message}` };
  }

  if (protocol !== ProtocolType.Sealevel) {
    return {
      error: `Chain ${chain} has protocol ${protocol}, not Sealevel; use safes/propose-warp-batch.ts instead`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read/parse JSON: ${message}` };
  }

  const parsed = ReceiptFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `Schema validation failed: ${parsed.error.message}` };
  }

  return { chain, txs: parsed.data };
}

/**
 * The automated Squads path only proposes simple receipts: one vault
 * transaction per source tx, executed by an external signer. It fundamentally
 * cannot enforce execution-time slot ordering, so a receipt requiring that
 * (`waitForSlotAdvance`) is rejected here (returning a reason) rather than
 * partially / incorrectly proposed, surfacing it for manual ordered
 * execution. A non-default compute budget is carried through to the proposal
 * (see `planReceiptProposals`) and surfaced for the executor to apply at
 * `vaultTransactionExecute`; ALT-compressed receipts are rehydrated from the
 * writer's expanded `instructions[]` (see `buildInstructionsFromPrintable`)
 * rather than decompiled from the wire.
 */
export function assertSimpleReceipt(
  txs: z.infer<typeof ReceiptFileSchema>,
): { ok: true } | { ok: false; reason: string } {
  for (const [index, tx] of txs.entries()) {
    const position = `transaction ${index + 1}/${txs.length}`;

    if (tx.waitForSlotAdvance === true) {
      return {
        ok: false,
        reason: `${position} requires execution-time slot-advance ordering (waitForSlotAdvance), which the proposer cannot enforce; propose and execute this receipt manually in order`,
      };
    }
  }
  return { ok: true };
}

/**
 * Turn a parsed receipt's source transactions into an ordered list of proposal
 * plans, one per source tx. Preserving the source-tx boundary (instead of
 * flattening every instruction into a single vault transaction) keeps each
 * step in its own Squads vault transaction. Each source tx's expanded
 * `instructions[]` is validated against its wire payload
 * (`validateInstructionsAgainstWire`) before being rehydrated
 * (`buildInstructionsFromPrintable`), and its `computeUnits` (if any) is
 * carried through for the executor to apply at execution time. Callers MUST
 * gate this behind `assertSimpleReceipt`: a slot-advance-barrier receipt is
 * rejected there, since only that case cannot be faithfully proposed.
 */
export function planReceiptProposals(
  txs: z.infer<typeof ReceiptFileSchema>,
): ReceiptProposalPlan[] {
  return txs.map((tx) => {
    validateInstructionsAgainstWire(tx.instructions, tx.transaction_base58);
    return {
      instructions: buildInstructionsFromPrintable(tx.instructions),
      computeUnits: tx.computeUnits,
    };
  });
}

/**
 * Collect the base58 pubkeys of every account marked as a signer across the
 * given instructions. For warp-token config updates the signer is the owning
 * authority — the Squads vault PDA when the route is Squads-governed.
 */
export function collectSignerAuthorities(
  instructions: TransactionInstruction[],
): string[] {
  const seen = new Set<string>();
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (key.isSigner) {
        seen.add(key.pubkey.toBase58());
      }
    }
  }
  return [...seen];
}

/**
 * Verify that every signer authority in the plan is the expected Squads vault
 * PDA. A route governed by a different vault (e.g. an AbacusWorks Squad routed
 * against the regular Squad, or vice versa) surfaces a foreign authority here,
 * so we fail closed rather than propose to the wrong multisig.
 */
export function assertAuthorizedByVault(
  plans: ReceiptProposalPlan[],
  vaultBase58: string,
): { ok: true } | { ok: false; reason: string } {
  const authorities = collectSignerAuthorities(
    plans.flatMap((plan) => plan.instructions),
  );
  if (authorities.length === 0) {
    return {
      ok: false,
      reason: 'Could not determine an instruction authority to verify',
    };
  }
  const foreign = authorities.filter(
    (authority) => !eqAddressSol(authority, vaultBase58),
  );
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `Instruction authority ${foreign.join(
        ', ',
      )} does not match expected Squads vault ${vaultBase58}`,
    };
  }
  return { ok: true };
}
