/**
 * Shared discovery, formatting, and submission logic for the moonpay
 * standing-quote scripts (print-quotes.ts, set-quotes.ts, propagate-quotes.ts).
 */

import { Wallet, constants, ethers } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  OffchainQuotedLinearFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  EvmTokenFeeReader,
  MultiProvider,
  OnchainTokenFeeType,
  convertToBps,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert, rootLogger } from '@hyperlane-xyz/utils';

import { getDomainId, getWarpCoreConfig } from '../../config/registry.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { fetchGCPSecret } from '../../src/utils/gcloud.js';

const logger = rootLogger.child({ module: 'moonpay-quotes' });

// Provider/RPC errors can embed the full request (including RPC URLs, which
// often carry API keys in the path/query) — log a truncated message only,
// never the raw error object.
function errMsg(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.slice(0, 200);
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const GCP_SIGNER_SECRET = 'hyperlane-mainnet3-key-quotesigner';
export const GCP_DEPLOYER_SECRET = 'hyperlane-mainnet3-key-deployer';

export const WILDCARD_DEST = 0xffffffff;
export const WILDCARD_RECIPIENT = '0x' + 'ff'.repeat(32);
export const ROUTE_IDS = [WarpRouteIds.CROSSCitreaMoonpay];

// EIP-712: matches AbstractOffchainQuoter.sol name/version
export const EIP712_NAME = 'OffchainQuoter';
export const EIP712_VERSION = '1';
export const SIGNED_QUOTE_TYPES = {
  SignedQuote: [
    { name: 'context', type: 'bytes' },
    { name: 'data', type: 'bytes' },
    { name: 'issuedAt', type: 'uint48' },
    { name: 'expiry', type: 'uint48' },
    { name: 'salt', type: 'bytes32' },
    { name: 'submitter', type: 'address' },
  ],
};

// Matches the contract's MAX_BPS (10_000 = 100%) — a sane hard upper bound
// so a fat-fingered --bps value can't lock in an absurd fee.
const MAX_SANE_BPS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OqlfSlot {
  origin: string;
  sourceToken: string; // normalised group label of the origin token (USDC / USDT / …)
  destination: string;
  destDomain: number;
  target: string; // "DEFAULT" or normalised group label of the destination token
  isDefault: boolean;
  oqlfAddress: string;
  onchainMaxFee: bigint;
  onchainHalfAmount: bigint;
  effectiveMaxFee: bigint;
  effectiveHalfAmount: bigint;
  effectiveSource: 'standing' | 'fallback';
  standingExpiry: number; // 0 when effectiveSource === 'fallback'
}

export interface GcpKeySecret {
  privateKey: string;
  address: string;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Display bps as "W.FF". */
export function fmtBps(maxFee: bigint, halfAmount: bigint): string {
  if (halfAmount === 0n) return '?.??';
  return convertToBps(maxFee, halfAmount).toFixed(2);
}

export function formatExpiry(ts: number): string {
  if (ts === 0) return '—';
  const remaining = ts - Math.floor(Date.now() / 1000);
  const abs = new Date(ts * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', 'Z');
  if (remaining <= 0) return `${abs} (expired)`;
  const h = Math.round(remaining / 3600);
  return `${abs} (${h}h)`;
}

// ── bps <-> (maxFee, halfAmount) ────────────────────────────────────────────

/**
 * Convert a numeric bps value to canonical (maxFee, halfAmount), delegating
 * to the SDK's EvmTokenFeeReader so deployed contracts stay consistent with
 * the rest of the fee tooling (and inherit its bps>0 / precision guards).
 */
export function bpsToParams(
  multiProvider: MultiProvider,
  chain: string,
  bps: number,
): { maxFee: bigint; halfAmount: bigint } {
  assert(
    Number.isFinite(bps) && bps > 0 && bps <= MAX_SANE_BPS,
    `bps must be a positive number no greater than ${MAX_SANE_BPS}, got ${bps}`,
  );
  return new EvmTokenFeeReader(multiProvider, chain).convertFromBps(bps);
}

// ── GCP secret handling ───────────────────────────────────────────────────────

export function isGcpKeySecret(secret: unknown): secret is GcpKeySecret {
  return (
    typeof secret === 'object' &&
    secret !== null &&
    'privateKey' in secret &&
    'address' in secret &&
    typeof secret.privateKey === 'string' &&
    typeof secret.address === 'string'
  );
}

export async function resolveGcpKey(secretName: string): Promise<GcpKeySecret> {
  const secret = await fetchGCPSecret(secretName);
  assert(
    isGcpKeySecret(secret),
    `Malformed GCP secret payload for ${secretName}: expected {privateKey, address}`,
  );
  const walletAddress = new Wallet(secret.privateKey).address;
  assert(
    walletAddress.toLowerCase() === secret.address.toLowerCase(),
    `Malformed GCP secret payload for ${secretName}: address does not match privateKey`,
  );
  return secret;
}

// ── Address / router label maps ────────────────────────────────────────────

export interface AddrMaps {
  addrToLabel: Map<string, string>; // normalized addr → label
  routersByChain: Map<string, string[]>; // chain → [addr]
}

/**
 * Builds address→label and chain→routers maps in a single pass over every
 * route's tokens. usd-coin→"USDC", tether→"USDT", else symbol.
 * EVM addresses are lowercased; non-EVM (e.g. Solana base58) are kept as-is.
 */
export function buildAddrMaps(routeIds: string[]): AddrMaps {
  const addrToLabel = new Map<string, string>();
  const routersByChain = new Map<string, string[]>();
  for (const routeId of routeIds) {
    const warpConfig = getWarpCoreConfig(routeId);
    for (const t of warpConfig.tokens) {
      if (!t.addressOrDenom) continue;
      const key = t.addressOrDenom.startsWith('0x')
        ? t.addressOrDenom.toLowerCase()
        : t.addressOrDenom;
      const label =
        t.coinGeckoId === 'usd-coin'
          ? 'USDC'
          : t.coinGeckoId === 'tether'
            ? 'USDT'
            : (t.symbol ?? t.chainName ?? key.slice(0, 10));
      addrToLabel.set(key, label);
      if (t.chainName) {
        const list = routersByChain.get(t.chainName) ?? [];
        if (!list.includes(key)) list.push(key);
        routersByChain.set(t.chainName, list);
      }
    }
  }
  return { addrToLabel, routersByChain };
}

// ── Slot discovery ────────────────────────────────────────────────────────────

/**
 * Discovers every OQLF slot (DEFAULT + per-router) across all origin/dest
 * pairs for the given routes, resolving the standing-quote → fallback
 * cascade the same way the on-chain contract does.
 */
export async function discoverOqlfSlots(
  multiProvider: MultiProvider,
  routeIds: string[] = ROUTE_IDS,
): Promise<OqlfSlot[]> {
  const { addrToLabel, routersByChain } = buildAddrMaps(routeIds);
  const now = Math.floor(Date.now() / 1000);
  const seenSlots = new Set<string>();
  const allSlots: OqlfSlot[] = [];

  await Promise.all(
    routeIds.flatMap((routeId) => {
      const warpConfig = getWarpCoreConfig(routeId);
      const seenOriginAddrs = new Set<string>();
      const evmTokens = warpConfig.tokens.filter((t) => {
        if (
          !t.addressOrDenom ||
          !t.chainName ||
          !/^0x[0-9a-f]{40}$/i.test(t.addressOrDenom)
        )
          return false;
        const key = `${t.chainName}:${t.addressOrDenom.toLowerCase()}`;
        if (seenOriginAddrs.has(key)) return false;
        seenOriginAddrs.add(key);
        return true;
      });

      return evmTokens.map(async (originToken) => {
        const { chainName: origin, addressOrDenom: routerAddr } = originToken;
        if (!routerAddr || !origin) return;
        const normalizedOriginAddr = routerAddr.toLowerCase();
        const sourceToken =
          addrToLabel.get(normalizedOriginAddr) ?? originToken.symbol ?? origin;
        const provider = multiProvider.getProvider(origin);

        let ccrAddress: string;
        try {
          ccrAddress = await TokenRouter__factory.connect(
            routerAddr,
            provider,
          ).feeRecipient();
        } catch (error) {
          logger.warn(
            { origin, routerAddr, error: errMsg(error) },
            'Failed to read feeRecipient; skipping origin token',
          );
          return;
        }
        if (!ccrAddress || ccrAddress === constants.AddressZero) return;

        let feeTypeNum: number;
        try {
          feeTypeNum = await BaseFee__factory.connect(
            ccrAddress,
            provider,
          ).feeType();
        } catch (error) {
          logger.warn(
            { origin, ccrAddress, error: errMsg(error) },
            'Failed to read feeType; skipping origin token',
          );
          return;
        }
        if (feeTypeNum !== OnchainTokenFeeType.CrossCollateralRoutingFee)
          return;

        const ccr = CrossCollateralRoutingFee__factory.connect(
          ccrAddress,
          provider,
        );

        let defaultRouterKey: string;
        try {
          defaultRouterKey = await ccr.DEFAULT_ROUTER();
        } catch (error) {
          logger.warn(
            { origin, ccrAddress, error: errMsg(error) },
            'Failed to read DEFAULT_ROUTER; skipping origin token',
          );
          return;
        }

        const seenDestChains = new Set<string>();
        const destTokens = warpConfig.tokens.filter((t) => {
          if (!t.chainName) return false;
          if (seenDestChains.has(t.chainName)) return false;
          seenDestChains.add(t.chainName);
          return true;
        });

        await Promise.all(
          destTokens.map(async (destToken) => {
            const { chainName: destination } = destToken;
            if (!destination) return;
            let destDomain: number;
            try {
              destDomain = getDomainId(destination);
            } catch (error) {
              logger.warn(
                { destination, error: errMsg(error) },
                'Failed to resolve domain id; skipping destination',
              );
              return;
            }

            const destRouters = routersByChain.get(destination) ?? [];
            const targetKeys: Array<{
              key: string;
              label: string;
              isDefault: boolean;
            }> = [
              { key: defaultRouterKey, label: 'DEFAULT', isDefault: true },
              ...destRouters.map((addr) => ({
                key: addressToBytes32(addr),
                label: addrToLabel.get(addr) ?? addr.slice(0, 10),
                isDefault: false,
              })),
            ];

            await Promise.all(
              targetKeys.map(async ({ key, label, isDefault }) => {
                let oqlfAddress: string;
                try {
                  oqlfAddress = await ccr.feeContracts(destDomain, key);
                } catch (error) {
                  logger.warn(
                    {
                      origin,
                      destination,
                      target: label,
                      error: errMsg(error),
                    },
                    'Failed to read feeContracts slot; skipping',
                  );
                  return;
                }
                if (!oqlfAddress || oqlfAddress === constants.AddressZero)
                  return;

                // Dedup key includes the target's on-chain identity (key, not
                // the display label): a per-router slot can legitimately
                // point at the same OQLF instance as DEFAULT, and both
                // logical targets must still surface separately so --targets
                // filtering (set-quotes.ts) sees every alias. Using the raw
                // key instead of label avoids any (extremely unlikely) label
                // collision between distinct target identities.
                const slotId = `${oqlfAddress.toLowerCase()}:${destDomain}:${origin}:${sourceToken}:${key}`;
                if (seenSlots.has(slotId)) return;
                seenSlots.add(slotId);

                const oqlf = OffchainQuotedLinearFee__factory.connect(
                  oqlfAddress,
                  provider,
                );
                const [onchainMaxFee, onchainHalfAmount] = await Promise.all([
                  oqlf.maxFee(),
                  oqlf.halfAmount(),
                ]);

                let effectiveMaxFee = onchainMaxFee.toBigInt();
                let effectiveHalfAmount = onchainHalfAmount.toBigInt();
                let effectiveSource: 'standing' | 'fallback' = 'fallback';
                let standingExpiry = 0;

                for (const { dest, recip } of [
                  { dest: destDomain, recip: WILDCARD_RECIPIENT },
                  { dest: WILDCARD_DEST, recip: WILDCARD_RECIPIENT },
                ]) {
                  const sq = await oqlf.quotes(dest, recip);
                  const expiry = Number(sq.expiry);
                  if (expiry > 0 && expiry >= now) {
                    effectiveMaxFee = sq.maxFee.toBigInt();
                    effectiveHalfAmount = sq.halfAmount.toBigInt();
                    effectiveSource = 'standing';
                    standingExpiry = expiry;
                    break;
                  }
                }

                allSlots.push({
                  origin,
                  sourceToken,
                  destination,
                  destDomain,
                  target: label,
                  isDefault,
                  oqlfAddress,
                  onchainMaxFee: onchainMaxFee.toBigInt(),
                  onchainHalfAmount: onchainHalfAmount.toBigInt(),
                  effectiveMaxFee,
                  effectiveHalfAmount,
                  effectiveSource,
                  standingExpiry,
                });
              }),
            );
          }),
        );
      });
    }),
  );

  // Concurrent discovery races RPC calls, so push order is nondeterministic
  // across runs — sort for stable, reproducible output. Origin → sourceToken
  // → destination, then DEFAULT first followed by alpha-sorted targets.
  allSlots.sort((a, b) => {
    const cmp =
      a.origin.localeCompare(b.origin) ||
      a.sourceToken.localeCompare(b.sourceToken) ||
      a.destination.localeCompare(b.destination);
    if (cmp !== 0) return cmp;
    if (a.target === 'DEFAULT') return -1;
    if (b.target === 'DEFAULT') return 1;
    return a.target.localeCompare(b.target);
  });

  return allSlots;
}

// ── Signer authorization ──────────────────────────────────────────────────────

/**
 * Verifies the signer is an authorized quote signer on every unique
 * (origin, OQLF contract) pair among the given slots, exiting the process
 * with a clear error if any are unauthorized. Keyed by (origin, oqlfAddress)
 * rather than just oqlfAddress, since deterministic (CREATE2) deployments can
 * put the same OQLF address on multiple chains with different authorized
 * signer sets.
 */
export async function verifySignerAuthorization(
  multiProvider: MultiProvider,
  signerKey: string,
  slots: OqlfSlot[],
): Promise<void> {
  const signerAddress = new Wallet(signerKey).address;
  const uniqueOqlfs = new Map<
    string,
    { oqlfAddress: string; origin: string }
  >();
  for (const slot of slots) {
    uniqueOqlfs.set(`${slot.origin}:${slot.oqlfAddress.toLowerCase()}`, {
      oqlfAddress: slot.oqlfAddress,
      origin: slot.origin,
    });
  }

  const unauthorized = (
    await Promise.all(
      [...uniqueOqlfs.values()].map(async ({ oqlfAddress, origin }) => {
        const provider = multiProvider.getProvider(origin);
        const oqlf = OffchainQuotedLinearFee__factory.connect(
          oqlfAddress,
          provider,
        );
        const authorized = await oqlf.isQuoteSigner(signerAddress);
        return authorized ? null : { oqlfAddress, origin };
      }),
    )
  ).filter((r): r is { oqlfAddress: string; origin: string } => r !== null);

  if (unauthorized.length > 0) {
    for (const { oqlfAddress, origin } of unauthorized) {
      const provider = multiProvider.getProvider(origin);
      const oqlf = OffchainQuotedLinearFee__factory.connect(
        oqlfAddress,
        provider,
      );
      const authorizedSigners = await oqlf.quoteSigners();
      console.error(
        `\nError: signer ${signerAddress} is NOT authorized on OQLF ${oqlfAddress} (origin ${origin}).`,
      );
      console.error(
        authorizedSigners.length === 0
          ? 'No authorized signers found — contract may not be configured.'
          : `Authorized signers: ${authorizedSigners.join(', ')}`,
      );
    }
    process.exit(1);
  }
  console.log(
    `Signer ${signerAddress} is authorized on all ${uniqueOqlfs.size} OQLF contract(s). Proceeding.\n`,
  );
}

// ── Sign + submit ─────────────────────────────────────────────────────────────

export interface QuoteSubmission {
  slot: OqlfSlot;
  maxFee: bigint;
  halfAmount: bigint;
  bpsLabel: string;
}

/**
 * Signs and submits a single standing quote, regenerating timestamps/salt on
 * each attempt so the signature stays fresh across retries.
 */
export async function submitQuoteWithRetry(
  multiProvider: MultiProvider,
  signerKey: string,
  submitterWallet: Wallet,
  submission: QuoteSubmission,
  ttlSeconds: number,
  maxAttempts = 3,
): Promise<void> {
  assert(
    Number.isFinite(ttlSeconds) && ttlSeconds > 0,
    `ttlSeconds must be a positive number, got ${ttlSeconds}`,
  );
  assert(maxAttempts > 0, `maxAttempts must be positive, got ${maxAttempts}`);

  const { slot, maxFee, halfAmount, bpsLabel } = submission;
  const provider = multiProvider.getProvider(slot.origin);
  const signerWallet = new Wallet(signerKey, provider);
  const submitter = submitterWallet.connect(provider);
  const { chainId } = await provider.getNetwork();

  const context = ethers.utils.solidityPack(
    ['uint32', 'bytes32', 'uint256'],
    [slot.destDomain, WILDCARD_RECIPIENT, constants.MaxUint256],
  );
  const data = ethers.utils.solidityPack(
    ['uint256', 'uint256'],
    [maxFee, halfAmount],
  );
  const domain = {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId,
    verifyingContract: slot.oqlfAddress,
  };
  const oqlf = OffchainQuotedLinearFee__factory.connect(
    slot.oqlfAddress,
    submitter,
  );
  const txOverrides = multiProvider.getTransactionOverrides(slot.origin);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const expiry = issuedAt + ttlSeconds;
      const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      const submitterAddr = constants.AddressZero;
      const message = {
        context,
        data,
        issuedAt,
        expiry,
        salt,
        submitter: submitterAddr,
      };
      const signature = await signerWallet._signTypedData(
        domain,
        SIGNED_QUOTE_TYPES,
        message,
      );

      const attemptSuffix = attempt > 1 ? ` (attempt ${attempt})` : '';
      process.stdout.write(
        `Submitting ${slot.origin} (${slot.sourceToken}) → ${slot.destination} / ${slot.target} (${bpsLabel} bps)${attemptSuffix}... `,
      );
      const tx = await oqlf.submitQuote(message, signature, txOverrides);
      process.stdout.write(`${tx.hash.slice(0, 14)}… `);
      await tx.wait(1);
      console.log('confirmed.');
      return;
    } catch (err) {
      lastErr = err;
      const msg =
        err instanceof Error ? err.message.slice(0, 120) : String(err);
      if (attempt < maxAttempts) {
        console.warn(`\n  attempt ${attempt} failed: ${msg} — retrying...`);
      } else {
        console.error(`\n  failed after ${maxAttempts} attempts: ${msg}`);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
