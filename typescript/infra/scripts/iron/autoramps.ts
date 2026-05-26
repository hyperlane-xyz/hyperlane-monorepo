/**
 * Manages Iron autoramps for USDC ↔ ctUSD direct deposits on the CROSS/moonpay route.
 *
 * Source of truth: deployments/warp_routes/USDC/moonpay-config.yaml in the registry.
 *
 * For every EVM chain in that YAML that connects to citrea (the ctUSD hub), two
 * autoramps are expected:
 *   Mint   – user deposits USDC on the EVM chain → Iron forwards to the citrea warp router
 *   Redeem – user deposits ctUSD on citrea → Iron forwards to the EVM chain warp router
 *
 * When the YAML gains a new chain (e.g. polygon), `status` will show it as MISSING
 * and `sync` will create the two autoramps.
 *
 * Commands:
 *   status  Show expected lanes with live Iron status and deposit addresses
 *   sync    Create autoramps for MISSING lanes
 *
 * Required env: IRON_API_KEY  (or set in typescript/infra/.env)
 *
 * Usage:
 *   pnpm iron:autoramps status
 *   pnpm iron:autoramps sync --dry-run
 *   pnpm iron:autoramps sync
 */

import 'dotenv/config';

import yargs from 'yargs';

import { WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { assert, eqAddress } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const IRON_API_BASE = 'https://api.iron.xyz/api';
const CID = '019ce28c-eead-7cf0-985f-64c711cb4e58';

// The warp route that defines which chains and routers exist.
const WARP_ROUTE_ID = WarpRouteIds.USDCCitreaMoonpay; // 'USDC/moonpay'

// The hub chain — every other EVM chain pairs with it.
const HUB = 'citrea';
const HUB_SYMBOL = 'ctUSD';

// ── Iron API types ─────────────────────────────────────────────────────────────

interface IronAutoramp {
  id: string;
  name: string | null;
  kind: 'Mint' | 'Redeem' | null;
  status: string | null;
  deposit_account: { address: string; chain: string } | null;
  recipient: { address: string; blockchain: string } | null;
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
): Promise<T> {
  const res = await fetch(`${IRON_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
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

// ── Chain name helpers ─────────────────────────────────────────────────────────

// Iron uses title-case names (Arbitrum, Base, Ethereum, Citrea, Polygon …).
// Simple capitalize works for all current chains; add overrides below if needed.
const IRON_NAME_OVERRIDES: Record<string, string> = {};

function toIron(chain: string): string {
  return (
    IRON_NAME_OVERRIDES[chain] ?? chain.charAt(0).toUpperCase() + chain.slice(1)
  );
}

function fromIron(ironName: string): string {
  return ironName.toLowerCase();
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
}

/**
 * Derive the expected lane specs from the USDC/moonpay warp route YAML.
 * Lanes are created for every EVM chain that has a direct connection to the hub (citrea).
 */
function loadLanesFromRegistry(): LaneSpec[] {
  const registry = getRegistry();
  const route = registry.getWarpRoute(WARP_ROUTE_ID) as WarpCoreConfig | null;
  assert(route, `Warp route '${WARP_ROUTE_ID}' not found in registry`);

  // Build chainName → router address map for all EVM tokens.
  const evmRouters = new Map<string, string>();
  for (const token of route.tokens) {
    if (token.standard?.startsWith('Evm') && token.addressOrDenom) {
      evmRouters.set(token.chainName, token.addressOrDenom);
    }
  }

  const hubRouter = evmRouters.get(HUB);
  assert(hubRouter, `No '${HUB}' EVM token found in route '${WARP_ROUTE_ID}'`);

  // Collect EVM chains that connect to the hub (excluding the hub itself).
  const evmChains = route.tokens
    .filter(
      (t) =>
        t.standard?.startsWith('Evm') &&
        t.chainName !== HUB &&
        t.connections?.some((c) => c.token.includes(`|${HUB}|`)),
    )
    .map((t) => ({
      chain: t.chainName,
      router: t.addressOrDenom!,
      symbol: t.symbol,
    }));

  assert(
    evmChains.length > 0,
    `No EVM chains with citrea connections found in '${WARP_ROUTE_ID}'`,
  );

  const lanes: LaneSpec[] = [];
  for (const { chain, router, symbol } of evmChains) {
    // Mint: USDC on EVM chain → Iron deposits to citrea warp router → ctUSD
    lanes.push({
      origin: chain,
      dest: HUB,
      kind: 'Mint',
      recipientAddress: hubRouter,
      originSymbol: symbol,
      destSymbol: HUB_SYMBOL,
    });
    // Redeem: ctUSD on citrea → Iron deposits to EVM warp router → USDC
    lanes.push({
      origin: HUB,
      dest: chain,
      kind: 'Redeem',
      recipientAddress: router,
      originSymbol: HUB_SYMBOL,
      destSymbol: symbol,
    });
  }

  return lanes;
}

// ── Lane matching ──────────────────────────────────────────────────────────────

function laneKey(origin: string, dest: string): string {
  return `${origin}→${dest}`;
}

/**
 * Match Iron autoramps to lane specs by origin+dest chain pair.
 * Returns the best match (verifying recipient address) or null.
 */
function matchAutoramp(
  candidates: IronAutoramp[],
  lane: LaneSpec,
): IronAutoramp | null {
  for (const a of candidates) {
    const aOrigin = fromIron(a.deposit_account?.chain ?? '');
    const aDest = fromIron(a.recipient?.blockchain ?? '');
    if (aOrigin !== lane.origin || aDest !== lane.dest) continue;

    // Verify the recipient address matches the expected warp router.
    const aRecipient = a.recipient?.address ?? '';
    if (!eqAddress(aRecipient, lane.recipientAddress)) continue;

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

// ── status ─────────────────────────────────────────────────────────────────────

async function cmdStatus(key: string): Promise<void> {
  const lanes = loadLanesFromRegistry();
  const autoramps = await fetchAllAutoramps(key);

  const matchedIds = new Set<string>();

  // Split into Mint and Redeem sections for readability.
  for (const kindLabel of ['Mint', 'Redeem'] as const) {
    const section = lanes.filter((l) => l.kind === kindLabel);
    const direction =
      kindLabel === 'Mint'
        ? `EVM → ${HUB} (${HUB_SYMBOL})`
        : `${HUB} (${HUB_SYMBOL}) → EVM`;

    console.log(`\n${kindLabel} — ${direction}`);

    const rows: string[][] = [];
    for (const lane of section) {
      const match = matchAutoramp(autoramps, lane);
      if (match?.id) matchedIds.add(match.id);

      rows.push([
        `${lane.origin} → ${lane.dest}`,
        match ? (match.status ?? '—') : 'MISSING',
        match?.id ?? '—',
        match?.deposit_account?.address ?? '—',
        lane.recipientAddress,
      ]);
    }

    printTable(
      [
        'Lane',
        'Status',
        'Autoramp ID',
        'Deposit address',
        'Recipient (warp router)',
      ],
      rows,
    );
  }

  // Show unmatched autoramps so they're visible.
  const unmatched = autoramps.filter((a) => !matchedIds.has(a.id));
  if (unmatched.length > 0) {
    console.log(`\nOther autoramps under this CID: ${unmatched.length}`);
    const rows = unmatched.map((a) => [
      a.id,
      a.name?.slice(0, 50) ?? '',
      a.kind ?? '—',
      a.status ?? '—',
      `${a.deposit_account?.address ?? '—'} (${a.deposit_account?.chain ?? '?'})`,
    ]);
    printTable(['ID', 'Name', 'Kind', 'Status', 'Deposit (chain)'], rows);
  }
}

// ── sync ───────────────────────────────────────────────────────────────────────

async function cmdSync(key: string, dryRun: boolean): Promise<void> {
  const lanes = loadLanesFromRegistry();
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
    const body = {
      cid: CID,
      name: `CROSS/moonpay ${lane.kind} ${toIron(lane.origin)} ${lane.originSymbol} -> ${toIron(lane.dest)} ${lane.destSymbol}`,
      kind: lane.kind,
      deposit_account: { chain: toIron(lane.origin) },
      recipient: {
        address: lane.recipientAddress,
        blockchain: toIron(lane.dest),
      },
    };

    console.log(`  ${lane.origin} → ${lane.dest}  (${lane.kind})`);
    console.log(`  recipient: ${lane.recipientAddress}`);

    if (dryRun) {
      console.log(`  payload: ${JSON.stringify(body)}\n`);
      continue;
    }

    const created = await apiPost<IronAutoramp>('/autoramps', key, body);
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
