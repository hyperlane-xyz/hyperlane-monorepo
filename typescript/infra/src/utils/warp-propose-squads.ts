import {
  TransactionInstruction,
  TransactionMessage,
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

// Mirrors svm-sdk's DEFAULT_COMPUTE_UNITS (typescript/svm-sdk/src/constants.ts).
// Warp config-update writers tag every transaction with this budget; a receipt
// tx carrying any other explicit budget (e.g. a program upgrade's
// MAX_COMPUTE_UNITS) cannot be honored — the Squads executor sets the vault
// transaction's compute budget itself at vaultTransactionExecute time — so we
// reject it rather than silently drop the budget. Kept as a local literal to
// avoid an infra→svm-sdk dependency edge.
const DEFAULT_SVM_COMPUTE_UNITS = 400_000;

// Shape produced by SvmSigner.transactionToPrintableJson in svm-sdk. Beyond the
// canonical wire bytes (`transaction_base58`) we read `waitForSlotAdvance` (the
// execution-ordering barrier for dependent multi-tx receipts such as program
// deploys) and `computeUnits` — both are read only to DETECT receipts the
// automated path cannot faithfully propose (see `assertSimpleReceipt`), never
// carried into the proposal. Passthrough keeps any additional writer fields.
export const PrintableSvmTransactionSchema = z
  .object({
    transaction_base58: z.string(),
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
 * execution-time ordering, a non-default compute budget, or address-lookup-table
 * compression are rejected upstream by `assertSimpleReceipt`, since the proposer
 * cannot faithfully reproduce any of those at execution time.
 */
export type ReceiptProposalPlan = {
  instructions: TransactionInstruction[];
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
 * Decodes a base58-encoded v0 unsigned transaction (produced by
 * `serializeUnsignedTransaction` in svm-sdk) back into legacy
 * `TransactionInstruction[]` consumable by the Squads submission helpers.
 *
 * The writer emits v0 transactions (`createTransactionMessage({ version: 0 })`),
 * so we must use `VersionedTransaction.deserialize` and decompile the message.
 * The writer does not use address-lookup tables, so `decompile` is called
 * without ALT args.
 */
export function rehydrateInstructions(
  transactionBase58: string,
): TransactionInstruction[] {
  const bytes = bs58.decode(transactionBase58);
  const versioned = VersionedTransaction.deserialize(bytes);
  const message = TransactionMessage.decompile(versioned.message);
  return message.instructions;
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
 * Detect whether a serialized v0 transaction is compressed with address-lookup
 * tables. Such a transaction cannot be rehydrated here (the ALT contents live
 * on-chain and are not carried in the receipt), so it must be rejected rather
 * than fed to `rehydrateInstructions`, whose ALT-less `decompile` would throw.
 */
export function hasAddressTableLookups(transactionBase58: string): boolean {
  const bytes = bs58.decode(transactionBase58);
  const versioned = VersionedTransaction.deserialize(bytes);
  const { message } = versioned;
  return (
    'addressTableLookups' in message && message.addressTableLookups.length > 0
  );
}

/**
 * The automated Squads path only proposes simple receipts: one vault
 * transaction per source tx, executed by an external signer that sets its own
 * compute budget and slot ordering. It fundamentally cannot enforce
 * execution-time slot ordering, carry a non-default compute budget, or
 * rehydrate an ALT-compressed transaction. Fail closed (returning a reason)
 * when a receipt needs any of those, so it is surfaced for manual ordered
 * execution instead of being partially / incorrectly proposed.
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

    if (
      tx.computeUnits !== undefined &&
      tx.computeUnits !== DEFAULT_SVM_COMPUTE_UNITS
    ) {
      return {
        ok: false,
        reason: `${position} carries a non-default compute budget (${tx.computeUnits}); the Squads executor sets the compute budget at execution time, so propose and execute this receipt manually`,
      };
    }

    if (hasAddressTableLookups(tx.transaction_base58)) {
      return {
        ok: false,
        reason: `${position} is address-lookup-table compressed and cannot be rehydrated from the receipt; propose and execute this receipt manually`,
      };
    }
  }
  return { ok: true };
}

/**
 * Turn a parsed receipt's source transactions into an ordered list of proposal
 * plans, one per source tx. Preserving the source-tx boundary (instead of
 * flattening every instruction into a single vault transaction) keeps each
 * step in its own Squads vault transaction. Callers MUST gate this behind
 * `assertSimpleReceipt`: a barrier / non-default-compute / ALT receipt is
 * rejected there, so every plan produced here is a simple, self-contained
 * vault transaction.
 */
export function planReceiptProposals(
  txs: z.infer<typeof ReceiptFileSchema>,
): ReceiptProposalPlan[] {
  return txs.map((tx) => ({
    instructions: rehydrateInstructions(tx.transaction_base58),
  }));
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
