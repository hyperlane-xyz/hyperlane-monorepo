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

// Shape produced by SvmSigner.transactionToPrintableJson in svm-sdk. Beyond the
// canonical wire bytes (`transaction_base58`) we read `waitForSlotAdvance` (the
// ordering barrier for dependent multi-tx receipts such as program deploys).
// The producer's serialized instructions do NOT include a compute-budget
// instruction (the CU limit lives in a separate field that only materializes as
// a ComputeBudget instruction on the live-send path), so the compute budget for
// a Squads vault transaction is the executor's responsibility at
// vaultTransactionExecute time, not the proposer's. Passthrough keeps any
// additional writer fields.
export const PrintableSvmTransactionSchema = z
  .object({
    transaction_base58: z.string(),
    waitForSlotAdvance: z.boolean().optional(),
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
 * A single source transaction rehydrated into instructions, retaining the
 * ordering barrier needed to submit it as its own ordered Squads proposal.
 * Compute units are not carried as a field: the rehydrated instructions contain
 * no compute-budget instruction, so the CU limit for the vault transaction is
 * set by the executor at vaultTransactionExecute time, not the proposer.
 */
export type ReceiptProposalPlan = {
  instructions: TransactionInstruction[];
  waitForSlotAdvance: boolean;
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
 * Turn a parsed receipt's source transactions into an ordered list of proposal
 * plans, one per source tx. Preserving the source-tx boundary (instead of
 * flattening every instruction into a single vault transaction) keeps each
 * dependent step — e.g. a program extend, upgrade, then config — in its own
 * Squads vault transaction so the loader is not handed several slots' worth of
 * work in one atomic execution.
 */
export function planReceiptProposals(
  txs: z.infer<typeof ReceiptFileSchema>,
): ReceiptProposalPlan[] {
  return txs.map((tx) => ({
    instructions: rehydrateInstructions(tx.transaction_base58),
    waitForSlotAdvance: tx.waitForSlotAdvance ?? false,
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
