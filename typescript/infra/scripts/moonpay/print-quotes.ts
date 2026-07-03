#!/usr/bin/env tsx
/**
 * Shows the effective fee bps a user pays right now for every direction in
 * the CROSS/moonpay warp routes, resolving the standing-quote → fallback
 * cascade the same way the on-chain contract does.
 *
 * Output columns:
 *   origin → dest  target  bps  source  fee contract  expires
 *
 *   src          – source token label (USDC / USDT / …)
 *   target       – DEFAULT or symbol of the destination token router
 *   bps          – effective fee rate: standing quote if active, else fallback
 *   source       – "standing" | "fallback"
 *   fee contract – OQLF address for this (destination, target) slot
 *   expires      – expiry of the standing quote, or "—" for fallback
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/moonpay/print-quotes.ts
 *   pnpm tsx scripts/moonpay/print-quotes.ts -r http://localhost:3000
 */

import yargs from 'yargs';

import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';

import { getRegistry } from '../../config/registry.js';

import {
  ROUTE_IDS,
  discoverOqlfSlots,
  fmtBps,
  formatExpiry,
} from './oqlf-lib.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

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

  for (const routeId of ROUTE_IDS) {
    console.log(`\n${'═'.repeat(78)}`);
    console.log(routeId);
    console.log('═'.repeat(78));

    const slots = await discoverOqlfSlots(multiProvider, [routeId]);
    if (slots.length === 0) {
      console.log('  (no rows)');
      continue;
    }

    const rows = slots.map((s) => ({
      origin: s.origin,
      sourceToken: s.sourceToken,
      destination: s.destination,
      target: s.target,
      oqlf: s.oqlfAddress,
      bps: fmtBps(s.effectiveMaxFee, s.effectiveHalfAmount),
      source: s.effectiveSource,
      expires: formatExpiry(s.standingExpiry),
    }));

    const W = {
      origin: Math.max(6, ...rows.map((r) => r.origin.length)),
      src: Math.max(3, ...rows.map((r) => r.sourceToken.length)),
      dest: Math.max(4, ...rows.map((r) => r.destination.length)),
      target: Math.max(6, ...rows.map((r) => r.target.length)),
      bps: Math.max(3, ...rows.map((r) => (r.bps + ' bps').length)),
      source: 8,
      oqlf: 42, // "0x" + 40 hex chars
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
      '   ' +
      pad('fee contract', W.oqlf) +
      '   expires';
    const divider = [
      W.origin,
      W.src,
      W.dest,
      W.target,
      W.bps,
      W.source,
      W.oqlf,
      30,
    ]
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
          pad(r.bps + ' bps', W.bps) +
          '   ' +
          pad(r.source, W.source) +
          '   ' +
          pad(r.oqlf, W.oqlf) +
          '   ' +
          r.expires,
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
