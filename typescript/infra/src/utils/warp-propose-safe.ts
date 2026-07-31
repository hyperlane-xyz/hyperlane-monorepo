import { MetaTransactionData } from '@safe-global/types-kit';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { getSafesByGovernanceForChain } from '../../config/environments/mainnet3/governance/utils.js';
import { GovernanceType } from '../governanceTypes.js';
import { retrySafeApi } from './safe.js';

// Filename pattern produced by `hyperlane warp apply`'s `writeCombinedBundles`:
// `combined-chainId<chainId>-safe<addr>-<timestamp>-receipts.json`.
// The producer builds the safe segment with `safeAddress.slice(0, 8)`, which
// keeps the leading `0x` and the first 6 hex nibbles (e.g. `0x3965ac`), so the
// captured prefix here is exactly that `0x`-prefixed 6-nibble form — NOT 8 bare
// hex chars.
export const RECEIPT_FILENAME_RE =
  /^combined-chainId(\d+)-safe(0x[0-9a-fA-F]{6})-\d+-receipts\.json$/;

export const ReceiptTxSchema = z
  .object({
    to: z.string(),
    value: z.union([z.string(), z.number()]).optional(),
    data: z.string().optional(),
    operation: z.number().optional(),
  })
  .passthrough();

export const ReceiptFileSchema = z.object({
  version: z.string(),
  chainId: z.string(),
  meta: z.record(z.unknown()).optional(),
  transactions: z.array(ReceiptTxSchema).min(1),
});

export type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

export type ParsedFilename = {
  chainIdStr: string;
  safePrefix: string;
};

export type GovernanceSafeEntry = {
  governanceType: GovernanceType;
  safe: Address;
};

export type ParsedReceipt = {
  chain: ChainName;
  safeAddress: Address;
  governanceType: GovernanceType;
  receipt: ReceiptFile;
};

/**
 * Parse a combined-bundle filename into its chainId + safe-address prefix.
 * Pure: no filesystem or provider access.
 */
export function parseFilename(
  filename: string,
): ParsedFilename | { error: string } {
  const match = filename.match(RECEIPT_FILENAME_RE);
  if (!match) {
    return {
      error:
        'Filename does not match combined-chainId<id>-safe<0x + 6 hex>-<ts>-receipts.json',
    };
  }
  return { chainIdStr: match[1], safePrefix: match[2] };
}

/**
 * Resolve the governance safe whose address begins with `safePrefix`. Because
 * the producer only encodes a 6-nibble prefix, more than one governance safe on
 * a chain could share it: that is treated as an unresolvable ambiguity and
 * fails closed rather than guessing.
 */
export function resolveGovernanceSafe(
  safePrefix: string,
  entries: GovernanceSafeEntry[],
): GovernanceSafeEntry | { error: string } {
  const wanted = safePrefix.toLowerCase();
  const matches = entries.filter(
    (entry) => entry.safe.toLowerCase().slice(0, wanted.length) === wanted,
  );
  if (matches.length === 0) {
    return { error: `No governance safe matches prefix ${safePrefix}` };
  }
  if (matches.length > 1) {
    return {
      error: `Ambiguous safe prefix ${safePrefix} matches ${matches.length} governance safes: ${matches
        .map((m) => `${m.governanceType}=${m.safe}`)
        .join(', ')}`,
    };
  }
  return matches[0];
}

export function parseReceiptFile(
  filePath: string,
  multiProvider: MultiProvider,
): ParsedReceipt | { error: string } {
  const filename = path.basename(filePath);
  const parsedName = parseFilename(filename);
  if ('error' in parsedName) {
    return parsedName;
  }
  const { chainIdStr, safePrefix } = parsedName;

  let chain: ChainName;
  try {
    chain = multiProvider.getChainName(chainIdStr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unknown chainId ${chainIdStr}: ${message}` };
  }

  const govMatch = resolveGovernanceSafe(
    safePrefix,
    getSafesByGovernanceForChain(chain),
  );
  if ('error' in govMatch) {
    return { error: `${govMatch.error} on ${chain}` };
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

  if (parsed.data.chainId !== chainIdStr) {
    return {
      error: `Filename chainId ${chainIdStr} does not match file's chainId ${parsed.data.chainId}`,
    };
  }

  return {
    chain,
    safeAddress: govMatch.safe,
    governanceType: govMatch.governanceType,
    receipt: parsed.data,
  };
}

export function toMetaTransactionData(
  tx: z.infer<typeof ReceiptTxSchema>,
): MetaTransactionData {
  return {
    to: tx.to,
    value: tx.value !== undefined ? tx.value.toString() : '0',
    data: tx.data ?? '0x',
    ...(tx.operation !== undefined ? { operation: tx.operation } : {}),
  };
}

/** Minimal slice of the Safe tx service needed to resolve the next nonce. */
export interface NonceService {
  getNextNonce(safeAddress: Address): Promise<string>;
}

/**
 * Lazily resolve a queue-aware base nonce per safe (Safe tx service's next
 * nonce = highest pending + 1), then hand out sequential nonces so multiple
 * bundles for one safe in a single run do not collide at a single nonce.
 */
export function createNonceAllocator() {
  const bases = new Map<string, number>();
  const offsets = new Map<string, number>();

  return async function nextNonce(
    safeAddress: Address,
    safeService: NonceService,
  ): Promise<number> {
    if (!bases.has(safeAddress)) {
      const raw = await retrySafeApi(() =>
        safeService.getNextNonce(safeAddress),
      );
      bases.set(safeAddress, parseInt(raw, 10));
      offsets.set(safeAddress, 0);
    }
    const base = bases.get(safeAddress) ?? 0;
    const offset = offsets.get(safeAddress) ?? 0;
    offsets.set(safeAddress, offset + 1);
    return base + offset;
  };
}

/**
 * Check whether the fixed proposer signer is an owner of the target safe.
 * The proposer (EvmLegacyDeployer) is only an owner of a subset of governance
 * types; proposing to a safe it does not own would fail on-chain, so callers
 * skip those files with the returned reason instead of attempting them.
 */
export function checkSignerOwnsSafe(
  owners: Address[],
  signerAddress: Address,
  governanceType: GovernanceType,
): { owned: true } | { owned: false; reason: string } {
  const owned = owners.some((owner) => eqAddress(owner, signerAddress));
  if (owned) {
    return { owned: true };
  }
  return {
    owned: false,
    reason: `Proposer ${signerAddress} is not an owner of the ${governanceType} safe`,
  };
}
