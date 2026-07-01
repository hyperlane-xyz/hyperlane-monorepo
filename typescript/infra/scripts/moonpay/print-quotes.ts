#!/usr/bin/env tsx
/**
 * Shows the effective fee bps a user pays right now for every direction in
 * the CROSS/moonpay warp routes, resolving the standing-quote → fallback
 * cascade the same way the on-chain contract does.
 *
 * Output columns:
 *   origin → dest  target  bps  source  expires
 *
 *   path    – "standard" = DEFAULT slot, used for generic transfers
 *             "targeted" = per-router slot, OVERRIDES DEFAULT for that token
 *   target  – DEFAULT or symbol of the destination token router
 *   bps     – effective fee rate: standing quote if active, else fallback
 *   source  – "standing" | "fallback"
 *   expires – expiry of the standing quote, or "—" for fallback
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/moonpay/print-quotes.ts
 *   pnpm tsx scripts/moonpay/print-quotes.ts -r http://localhost:3000
 */

import yargs from 'yargs';
import { constants } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  OffchainQuotedLinearFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider, OnchainTokenFeeType } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  getDomainId,
  getRegistry,
  getWarpCoreConfig,
} from '../../config/registry.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const WILDCARD_DEST = 0xffffffff; // uint32 max
const WILDCARD_RECIPIENT = '0x' + 'ff'.repeat(32); // bytes32 max

// keccak256("RoutingFee.DEFAULT_ROUTER")
const DEFAULT_ROUTER_KEY =
  '0x6e086cd647d6eb8b516856666e2c1465fb8a6a58d3a75938362acc674eacaf47';

const ROUTE_IDS = [WarpRouteIds.CROSSCitreaMoonpay];

// ── Types ─────────────────────────────────────────────────────────────────────

interface EffectiveQuote {
  bps: string;
  source: 'standing' | 'fallback';
  expiry: number; // 0 = fallback (no expiry)
  quoteKey: string; // which standing key was active, e.g. "(8453,*)"
}

interface Row {
  origin: string;
  sourceToken: string; // normalised group label: USDC / USDT / …
  destination: string;
  target: string; // DEFAULT or normalised group label of the destination token
  oqlf: string;
  quote: EffectiveQuote;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function toBps(maxFee: bigint, halfAmount: bigint): string {
  if (halfAmount === 0n) return '?.??';
  // bps = maxFee * 10000 / (halfAmount * 2)
  const denom = halfAmount * 2n;
  const whole = (maxFee * 10000n) / denom;
  const frac = (maxFee * 1_000_000n) / denom - whole * 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

function formatExpiry(ts: number): string {
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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function resolveEffective(
  oqlfAddress: string,
  destDomain: number,
  provider: ReturnType<MultiProvider['getProvider']>,
  now: number,
): Promise<EffectiveQuote> {
  const oqlf = OffchainQuotedLinearFee__factory.connect(oqlfAddress, provider);

  // Probe standing quotes: resolution order matches the contract cascade.
  // (dest, *) is more specific than (*, *), so check it first.
  const keysToProbe = [
    { dest: destDomain, recip: WILDCARD_RECIPIENT, label: `(${destDomain},*)` },
    { dest: WILDCARD_DEST, recip: WILDCARD_RECIPIENT, label: '(*,*)' },
  ];

  for (const { dest, recip, label } of keysToProbe) {
    const sq = await oqlf.quotes(dest, recip);
    const expiry = Number(sq.expiry);
    if (expiry > 0 && expiry >= now) {
      return {
        bps: toBps(sq.maxFee.toBigInt(), sq.halfAmount.toBigInt()),
        source: 'standing',
        expiry,
        quoteKey: label,
      };
    }
  }

  // No active standing quote — use immutable fallback.
  const [maxFee, halfAmount] = await Promise.all([
    oqlf.maxFee(),
    oqlf.halfAmount(),
  ]);
  return {
    bps: toBps(maxFee.toBigInt(), halfAmount.toBigInt()),
    source: 'fallback',
    expiry: 0,
    quoteKey: '—',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { registry: registryUri } = await yargs(process.argv.slice(2))
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (filesystem path or http://…)',
    })
    .parseAsync();

  // For chain metadata (and thus RPC URLs), use the HTTP registry when -r is
  // provided — it overlays private RPC URLs without replacing the filesystem
  // registry that getWarpCoreConfig / getDomainId rely on.
  const rpcRegistry = registryUri
    ? getMergedRegistry({ registryUris: [registryUri], enableProxy: true })
    : getRegistry();
  const chainMetadata = await rpcRegistry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);
  const now = Math.floor(Date.now() / 1000);

  // Build address→label map for all token routers across all routes.
  // usd-coin→"USDC", tether→"USDT", else symbol.
  // EVM addresses are lowercased; non-EVM (e.g. Solana base58) are kept as-is.
  const addrToLabel = new Map<string, string>(); // normalized addr → label
  for (const routeId of ROUTE_IDS) {
    const warpConfig = getWarpCoreConfig(routeId);
    for (const t of warpConfig.tokens) {
      if (t.addressOrDenom) {
        const key = t.addressOrDenom.startsWith('0x')
          ? t.addressOrDenom.toLowerCase()
          : t.addressOrDenom;
        const label =
          t.coinGeckoId === 'usd-coin'
            ? 'USDC'
            : t.coinGeckoId === 'tether'
              ? 'USDT'
              : (t.symbol ?? t.chainName);
        addrToLabel.set(key, label);
      }
    }
  }

  // Collect all router addresses per chain (both EVM and non-EVM, all routes combined).
  const routersByChain = new Map<string, string[]>(); // chain → [addr]
  for (const routeId of ROUTE_IDS) {
    const warpConfig = getWarpCoreConfig(routeId);
    for (const t of warpConfig.tokens) {
      if (t.addressOrDenom && t.chainName) {
        const normalizedAddr = t.addressOrDenom.startsWith('0x')
          ? t.addressOrDenom.toLowerCase()
          : t.addressOrDenom;
        const list = routersByChain.get(t.chainName) ?? [];
        if (!list.includes(normalizedAddr)) list.push(normalizedAddr);
        routersByChain.set(t.chainName, list);
      }
    }
  }

  for (const routeId of ROUTE_IDS) {
    console.log(`\n${'═'.repeat(78)}`);
    console.log(routeId);
    console.log('═'.repeat(78));

    const warpConfig = getWarpCoreConfig(routeId);
    const evmTokens = warpConfig.tokens.filter(
      (t) =>
        t.addressOrDenom &&
        t.chainName &&
        /^0x[0-9a-f]{40}$/i.test(t.addressOrDenom),
    );

    // Process all origins concurrently.
    const originRows = await Promise.all(
      evmTokens.map(async (originToken): Promise<Row[]> => {
        const { chainName: origin, addressOrDenom: routerAddress } =
          originToken;
        if (!routerAddress || !origin) return [];
        const normalizedOriginAddr = routerAddress.toLowerCase();
        const sourceToken =
          addrToLabel.get(normalizedOriginAddr) ?? originToken.symbol ?? origin;

        const provider = multiProvider.getProvider(origin);

        // Get feeRecipient → must be a CrossCollateralRoutingFee.
        let ccrAddress: string;
        try {
          ccrAddress = await TokenRouter__factory.connect(
            routerAddress,
            provider,
          ).feeRecipient();
        } catch {
          return [];
        }
        if (!ccrAddress || ccrAddress === constants.AddressZero) return [];

        let feeTypeNum: number;
        try {
          feeTypeNum = await BaseFee__factory.connect(
            ccrAddress,
            provider,
          ).feeType();
        } catch {
          return [];
        }
        if (feeTypeNum !== OnchainTokenFeeType.CrossCollateralRoutingFee)
          return [];

        const ccr = CrossCollateralRoutingFee__factory.connect(
          ccrAddress,
          provider,
        );

        // Process all destinations concurrently, including same-chain
        // (e.g. arbitrum USDC → arbitrum USDT cross-collateral swap).
        const destTokens = warpConfig.tokens.filter((t) => !!t.chainName);

        const destRows = await Promise.all(
          destTokens.map(async (destToken): Promise<Row[]> => {
            const { chainName: destination } = destToken;
            if (!destination) return [];

            let destDomain: number;
            try {
              destDomain = getDomainId(destination);
            } catch {
              return [];
            }

            // Build targetRouter keys: DEFAULT + all routers on dest chain (EVM and non-EVM).
            const destRouters = routersByChain.get(destination) ?? [];
            const targetKeys: Array<{ key: string; label: string }> = [
              { key: DEFAULT_ROUTER_KEY, label: 'DEFAULT' },
              ...destRouters.map((addr) => ({
                key: addressToBytes32(addr),
                label: addrToLabel.get(addr) ?? addr.slice(0, 10),
              })),
            ];

            // Resolve all targetRouter slots concurrently.
            const keyRows = await Promise.all(
              targetKeys.map(async ({ key, label }): Promise<Row | null> => {
                let oqlfAddress: string;
                try {
                  oqlfAddress = await ccr.feeContracts(destDomain, key);
                } catch {
                  return null;
                }
                if (!oqlfAddress || oqlfAddress === constants.AddressZero)
                  return null;

                const quote = await resolveEffective(
                  oqlfAddress,
                  destDomain,
                  provider,
                  now,
                );
                return {
                  origin,
                  sourceToken,
                  destination,
                  target: label,
                  oqlf: oqlfAddress,
                  quote,
                };
              }),
            );

            return keyRows.filter((r): r is Row => r !== null);
          }),
        );

        return destRows.flat();
      }),
    );

    // Print table.
    const rows = originRows.flat();
    if (rows.length === 0) {
      console.log('  (no rows)');
      continue;
    }

    const W = {
      origin: Math.max(6, ...rows.map((r) => r.origin.length)),
      src: Math.max(3, ...rows.map((r) => r.sourceToken.length)),
      dest: Math.max(4, ...rows.map((r) => r.destination.length)),
      target: Math.max(6, ...rows.map((r) => r.target.length)),
      bps: Math.max(3, ...rows.map((r) => (r.quote.bps + ' bps').length)),
      source: 8,
    };
    const header =
      pad('origin', W.origin) +
      '   ' +
      pad('src', W.src) +
      '   ' +
      pad('dest', W.dest) +
      '   ' +
      pad('target', W.target) +
      '   ' +
      pad('bps', W.bps) +
      '   ' +
      pad('source', W.source) +
      '   expires';
    const divider = [W.origin, W.src, W.dest, W.target, W.bps, W.source, 30]
      .map((w) => '─'.repeat(w))
      .join('   ');

    console.log('\n' + header);
    console.log(divider);

    for (const r of rows) {
      console.log(
        pad(r.origin, W.origin) +
          '   ' +
          pad(r.sourceToken, W.src) +
          ' → ' +
          pad(r.destination, W.dest) +
          '   ' +
          pad(r.target, W.target) +
          '   ' +
          pad(r.quote.bps + ' bps', W.bps) +
          '   ' +
          pad(r.quote.source, W.source) +
          '   ' +
          formatExpiry(r.quote.expiry),
      );
    }
  }

  console.log('\nDone.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
