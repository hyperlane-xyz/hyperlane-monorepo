#!/usr/bin/env tsx
/**
 * MoonPay: manages Iron autoramps for the CROSS/moonpay route (USDC and USDT).
 *
 * Sources of truth (registry):
 *   deployments/warp_routes/USDC/moonpay-config.yaml
 *   deployments/warp_routes/USDT/moonpay-config.yaml
 *
 * Only pairs involving a hub chain (citrea = ctUSD, solanamainnet = XO) get autoramps.
 * ctUSD↔XO pairs are excluded.
 *
 * Per direction two autoramps are expected for citrea pairs:
 *   direct    – "CROSS/moonpay Mint …"    – routes to the warp router
 *   inventory – "CROSS/moonpay Inventory Mint …" – routes to the operator
 *
 * XO (solanamainnet) pairs get inventory lanes only.
 *
 * Matching uses chain pair + name pattern ("Inventory" substring) to tell the two
 * apart, since both can exist for the same origin↔dest.
 *
 * Commands:
 *   status  Show expected lanes with live Iron status and deposit addresses
 *   sync    Create autoramps for MISSING lanes
 *
 * Required env: IRON_API_KEY  (or set in typescript/infra/.env)
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/moonpay/autoramps.ts status
 *   pnpm tsx scripts/moonpay/autoramps.ts sync --dry-run
 *   pnpm tsx scripts/moonpay/autoramps.ts sync
 */

import 'dotenv/config';

import yargs from 'yargs';

import { WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const IRON_API_BASE = 'https://api.iron.xyz/api';
const CID = '019ce28c-eead-7cf0-985f-64c711cb4e58';

// Hub chains: only pairs involving exactly one of these get autoramps.
// citrea pairs → direct + inventory lanes; solanamainnet pairs → inventory only.
const CITREA = 'citrea';
const SOLANA = 'solanamainnet';
const HUB_CHAINS = new Set([CITREA, SOLANA]);

// Recipient for inventory autoramps, keyed by destination chain.
const INVENTORY_RECIPIENTS: Record<string, string> = {
  [SOLANA]: '4ZJoMHQPEMkeExtFQLbuh8nB21dxHj741dSo6oJ5BcMo',
};
const INVENTORY_RECIPIENT_DEFAULT =
  '0x93240AD82ca750da33de564F8dcE8EBEB5885822';

function inventoryRecipient(destChain: string): string {
  return INVENTORY_RECIPIENTS[destChain] ?? INVENTORY_RECIPIENT_DEFAULT;
}

interface RouteConfig {
  warpRouteId: string;
  /** Display label used in section headers. */
  label: string;
}

const ROUTE_CONFIGS: RouteConfig[] = [
  {
    warpRouteId: WarpRouteIds.USDCCitreaMoonpay,
    label: 'USDC/moonpay',
  },
  {
    warpRouteId: WarpRouteIds.USDTCitreaMoonpay,
    label: 'USDT/moonpay',
  },
];

// ── Iron API types ─────────────────────────────────────────────────────────────

interface IronAutoramp {
  id: string;
  name: string | null;
  kind: 'Mint' | 'Redeem' | null;
  status: string | null;
  deposit_account: { address: string; chain: string } | null;
  recipient: { address: string; blockchain: string } | null;
  operator: { id: string; name: string } | null;
}

interface IronListResponse {
  cursor?: string | null;
  items: IronAutoramp[];
}

// ── Iron API helpers ───────────────────────────────────────────────────────────

async function apiGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${IRON_API_BASE}${path}`, {
    headers: { 'X-API-Key': key },
  });
  if (!res.ok)
    throw new Error(
      `GET ${path} → ${res.status}: ${await res.text().catch(() => '')}`,
    );
  return res.json() as Promise<T>;
}

async function apiPost<T>(
  path: string,
  key: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  const res = await fetch(`${IRON_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `POST ${path} → ${res.status}: ${await res.text().catch(() => '')}`,
    );
  return res.json() as Promise<T>;
}

async function fetchAllAutoramps(key: string): Promise<IronAutoramp[]> {
  const items: IronAutoramp[] = [];
  let cursor: string | undefined;
  while (true) {
    const qs = new URLSearchParams({ cid: CID, limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    const page = await apiGet<IronListResponse>(`/autoramps?${qs}`, key);
    items.push(...(page.items ?? []));
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return items;
}

// ── Chain / symbol name helpers ────────────────────────────────────────────────

// Iron uses title-case names (Arbitrum, Base, Ethereum, Citrea, Polygon …).
const IRON_NAME_OVERRIDES: Record<string, string> = {
  solanamainnet: 'Solana',
};

function toIron(chain: string): string {
  return (
    IRON_NAME_OVERRIDES[chain] ?? chain.charAt(0).toUpperCase() + chain.slice(1)
  );
}

// Inverted overrides for reverse lookups: 'solana' → 'solanamainnet'.
const IRON_NAME_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(IRON_NAME_OVERRIDES).map(([k, v]) => [v.toLowerCase(), k]),
);

function fromIron(ironName: string): string {
  const lower = ironName.toLowerCase();
  return IRON_NAME_REVERSE[lower] ?? lower;
}

// Normalise token symbols that vary by chain to a canonical Iron-friendly name.
// e.g. Arbitrum's native USDT is registered as "USD₮0" in the registry.
const IRON_SYMBOL_OVERRIDES: Record<string, string> = {
  'USD₮0': 'USDT',
};

function toIronSymbol(symbol: string): string {
  return IRON_SYMBOL_OVERRIDES[symbol] ?? symbol;
}

// ── Registry helpers ───────────────────────────────────────────────────────────

interface LaneSpec {
  origin: string;
  dest: string;
  kind: 'Mint' | 'Redeem';
  /** Expected recipient address on dest chain (the warp router) */
  recipientAddress: string;
  originSymbol: string;
  destSymbol: string;
  /** direct = USDC↔ctUSD warp-router deposit; inventory = operator-managed rebalancing */
  type: 'direct' | 'inventory';
  /** Which moonpay route this lane belongs to */
  routeLabel: string;
}

/**
 * Derive all expected lane specs for a single moonpay warp route.
 *
 * Only pairs involving exactly one hub chain (citrea or solanamainnet) are included.
 * For citrea pairs: both a direct and an inventory spec are emitted.
 * For solanamainnet pairs: inventory only.
 */
function loadLanesForRoute(config: RouteConfig): LaneSpec[] {
  const registry = getRegistry();

  const route = registry.getWarpRoute(
    config.warpRouteId,
  ) as WarpCoreConfig | null;
  assert(route, `Warp route '${config.warpRouteId}' not found in registry`);

  // All tokens with a router address (EVM and Sealevel).
  const tokens = route.tokens.filter((t) => t.addressOrDenom);

  const router = new Map<string, string>(
    tokens.map((t) => [t.chainName, t.addressOrDenom!]),
  );
  const symbol = new Map<string, string>(
    tokens.map((t) => [t.chainName, t.symbol]),
  );

  const lanes: LaneSpec[] = [];
  const seen = new Set<string>();

  for (const a of tokens) {
    for (const conn of a.connections ?? []) {
      const bChain = conn.token.split('|')[1];

      if (!router.has(bChain)) continue;

      const pairKey = [a.chainName, bChain].sort().join('↔');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      // Only pairs involving exactly one hub chain.
      const aIsHub = HUB_CHAINS.has(a.chainName);
      const bIsHub = HUB_CHAINS.has(bChain);
      if (aIsHub === bIsHub) continue;

      const hubChain = aIsHub ? a.chainName : bChain;
      const spokeChain = aIsHub ? bChain : a.chainName;
      const isCitreaPair = hubChain === CITREA;

      // Mint: spoke → hub (user deposits spoke token, hub token is minted/received)
      // Redeem: hub → spoke (user deposits hub token, spoke token is released)
      const baseMint = {
        origin: spokeChain,
        dest: hubChain,
        recipientAddress: router.get(hubChain)!,
        originSymbol: symbol.get(spokeChain)!,
        destSymbol: symbol.get(hubChain)!,
        routeLabel: config.label,
      };
      const baseRedeem = {
        origin: hubChain,
        dest: spokeChain,
        recipientAddress: router.get(spokeChain)!,
        originSymbol: symbol.get(hubChain)!,
        destSymbol: symbol.get(spokeChain)!,
        routeLabel: config.label,
      };

      // Citrea pairs: direct + inventory. Solanamainnet pairs: inventory only.
      const types: Array<'direct' | 'inventory'> = isCitreaPair
        ? ['direct', 'inventory']
        : ['inventory'];

      for (const type of types) {
        lanes.push({
          ...baseMint,
          kind: 'Mint',
          type,
          ...(type === 'inventory' && {
            recipientAddress: inventoryRecipient(hubChain),
          }),
        });
        lanes.push({
          ...baseRedeem,
          kind: 'Redeem',
          type,
          ...(type === 'inventory' && {
            recipientAddress: inventoryRecipient(spokeChain),
          }),
        });
      }
    }
  }

  return lanes;
}

function loadAllLanes(): LaneSpec[] {
  return ROUTE_CONFIGS.flatMap(loadLanesForRoute);
}

// ── Lane matching ──────────────────────────────────────────────────────────────

function isInventoryName(name: string | null): boolean {
  return (name ?? '').includes('Inventory');
}

/**
 * Match an Iron autoramp to a lane spec by chain pair and name pattern.
 *
 * Direct lanes match autoramps whose name does NOT contain "Inventory".
 * Inventory lanes match autoramps whose name DOES contain "Inventory".
 *
 * This separates the two autoramps that can exist for the same chain pair
 * (e.g. both "CROSS/moonpay Mint Polygon USDC -> Citrea ctUSD" and
 * "CROSS/moonpay Inventory Mint Polygon USDC -> Citrea ctUSD").
 */
function matchAutoramp(
  candidates: IronAutoramp[],
  lane: LaneSpec,
): IronAutoramp | null {
  for (const a of candidates) {
    const aOrigin = fromIron(a.deposit_account?.chain ?? '');
    const aDest = fromIron(a.recipient?.blockchain ?? '');
    if (aOrigin !== lane.origin || aDest !== lane.dest) continue;
    if (lane.type === 'inventory' && !isInventoryName(a.name)) continue;
    if (lane.type === 'direct' && isInventoryName(a.name)) continue;
    return a;
  }
  return null;
}

// ── Table printer ──────────────────────────────────────────────────────────────

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  console.log(fmt(headers));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(fmt(row));
}

const trunc = (v: string | null | undefined, n: number) => {
  const s = v ?? '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// ── status ─────────────────────────────────────────────────────────────────────

async function cmdStatus(key: string): Promise<void> {
  const lanes = loadAllLanes();
  const autoramps = await fetchAllAutoramps(key);

  const matchedIds = new Set<string>();

  for (const routeConfig of ROUTE_CONFIGS) {
    const routeLanes = lanes.filter((l) => l.routeLabel === routeConfig.label);
    console.log(
      `\n${'═'.repeat(60)}\n${routeConfig.label.toUpperCase()}\n${'═'.repeat(60)}`,
    );

    for (const type of ['direct', 'inventory'] as const) {
      const section = routeLanes.filter((l) => l.type === type);
      if (section.length === 0) continue;

      console.log(`\n── ${type} ──`);

      for (const kindLabel of ['Mint', 'Redeem'] as const) {
        const kindSection = section.filter((l) => l.kind === kindLabel);
        if (kindSection.length === 0) continue;

        console.log(`\n${kindLabel}`);

        const rows: string[][] = [];
        for (const lane of kindSection) {
          const match = matchAutoramp(autoramps, lane);
          if (match?.id) matchedIds.add(match.id);

          rows.push([
            `${lane.origin} → ${lane.dest}`,
            match ? (match.status ?? '—') : 'MISSING',
            match?.id ?? '—',
            match?.deposit_account?.address ?? '—',
            lane.recipientAddress,
            match?.operator?.name ?? '—',
          ]);
        }

        printTable(
          [
            'Lane',
            'Status',
            'Autoramp ID',
            'Deposit address',
            'Recipient',
            'Operator',
          ],
          rows,
        );
      }
    }
  }

  // Show unmatched autoramps so they're visible.
  const unmatched = autoramps.filter((a) => !matchedIds.has(a.id));
  if (unmatched.length > 0) {
    console.log(`\nOther autoramps under this CID: ${unmatched.length}`);
    const rows = unmatched.map((a) => [
      a.id,
      trunc(a.name, 50),
      a.kind ?? '—',
      a.status ?? '—',
      `${a.deposit_account?.address ?? '—'} (${a.deposit_account?.chain ?? '?'})`,
      a.operator?.name ?? '—',
    ]);
    printTable(
      ['ID', 'Name', 'Kind', 'Status', 'Deposit (chain)', 'Operator'],
      rows,
    );
  }
}

// ── sync ───────────────────────────────────────────────────────────────────────

function buildName(lane: LaneSpec): string {
  const inventory = lane.type === 'inventory' ? 'Inventory ' : '';
  const operatorSuffix =
    lane.type === 'inventory'
      ? ` (operator ${lane.recipientAddress.slice(0, 10)})`
      : '';
  return `CROSS/moonpay ${inventory}${lane.kind} ${toIron(lane.origin)} ${toIronSymbol(lane.originSymbol)} -> ${toIron(lane.dest)} ${toIronSymbol(lane.destSymbol)}${operatorSuffix}`;
}

async function cmdSync(key: string, dryRun: boolean): Promise<void> {
  const lanes = loadAllLanes();
  const autoramps = await fetchAllAutoramps(key);

  const missing = lanes.filter((l) => matchAutoramp(autoramps, l) === null);

  if (missing.length === 0) {
    console.log('All lanes have autoramps — nothing to create.');
    return;
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Creating ${missing.length} missing autoramp(s):\n`,
  );

  for (const lane of missing) {
    const name = buildName(lane);
    const body = {
      customer_id: CID,
      name,
      source_currencies: [
        {
          type: 'Crypto',
          token: toIronSymbol(lane.originSymbol),
          blockchain: toIron(lane.origin),
        },
      ],
      destination_currency: {
        type: 'Crypto',
        token: toIronSymbol(lane.destSymbol),
        blockchain: toIron(lane.dest),
      },
      recipient_account: {
        type: 'Crypto',
        chain: toIron(lane.dest),
        address: lane.recipientAddress,
      },
    };

    console.log(
      `  [${lane.type}] ${lane.origin} → ${lane.dest}  (${lane.kind})`,
    );
    console.log(`  name:      ${name}`);
    console.log(`  recipient: ${lane.recipientAddress}`);

    if (dryRun) {
      console.log(`  payload: ${JSON.stringify(body)}\n`);
      continue;
    }

    const created = await apiPost<IronAutoramp>('/autoramps', key, body, name);
    const deposit = created.deposit_account?.address ?? '(unknown)';
    console.log(`  ✓ id: ${created.id}`);
    console.log(`    deposit: ${deposit}\n`);
  }

  if (!dryRun) {
    console.log('Run `status` to see the updated deposit addresses.');
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .usage('$0 <command> [options]')
    .command(
      'status',
      'Show expected lanes with live status and deposit addresses',
    )
    .command('sync', 'Create autoramps for MISSING lanes', (y) =>
      y.option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'Preview payloads without calling the Iron API',
      }),
    )
    .demandCommand(1, 'Specify a command: status | sync')
    .strict()
    .parseAsync();

  const apiKey = process.env.IRON_API_KEY;
  assert(
    apiKey,
    'IRON_API_KEY env var is required (or set in typescript/infra/.env)',
  );

  const a = argv as any;
  const [cmd] = a._ as string[];

  switch (cmd) {
    case 'status':
      await cmdStatus(apiKey);
      break;
    case 'sync':
      await cmdSync(apiKey, a.dryRun);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
