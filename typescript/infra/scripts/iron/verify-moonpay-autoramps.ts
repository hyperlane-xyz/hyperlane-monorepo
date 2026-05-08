/**
 * Verifies the six MCR Iron autoramps for `CROSS/moonpay` against the
 * registry. Per-lane checks:
 *
 *   A. iron.deposit_account.address
 *      == ctusd-ironbridge.<src>.destinationConfigs.<dst>.<routerKey>.depositAddress
 *   B. iron.recipient.address
 *      == decode(routerKey)        // bytes32 -> 20-byte EVM address
 *   C. iron.recipient.address
 *      == USDC/moonpay token where chainName=<dst>
 *
 * Source of truth:
 *   - `deployments/warp_routes/USDC/moonpay-config.yaml` (router addresses)
 *   - `deployments/warp_routes/CROSS/ctusd-ironbridge-deploy.yaml`
 *     (depositAddress + bytes32-encoded destination router keys)
 * Both read via `getRegistry()` from the local registry checkout —
 * `<monorepo>/../../hyperlane-registry`. No RPC, no GitHub fetch.
 *
 * Required env: IRON_API_KEY
 */

import yargs from 'yargs';

import type { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { getRegistry } from '../../config/registry.js';

const IRON_API_BASE = 'https://api.iron.xyz/api';

const DEFAULT_WARP_ROUTE_ID = 'USDC/moonpay';
const DEFAULT_IRONBRIDGE_ROUTE_ID = 'CROSS/ctusd-ironbridge';

// Iron API → registry chain-name normalisation. Iron returns capitalised
// names on `deposit_account.chain` / `recipient.blockchain`; the registry
// keys configs by lowercase chain name.
const IRON_CHAIN_TO_REGISTRY: Record<string, string> = {
  Arbitrum: 'arbitrum',
  Base: 'base',
  Ethereum: 'ethereum',
  Citrea: 'citrea',
};

interface IronAutoramp {
  id: string;
  name: string;
  kind: 'Mint' | 'Redeem';
  status: string;
  deposit_account: { address: string; chain: string };
  recipient: { address: string; blockchain: string };
}

interface IronAutorampListResponse {
  cursor?: string;
  items: IronAutoramp[];
}

interface LaneCheck {
  autorampId: string;
  name: string;
  origin: string;
  destination: string;
  ironDepositAddress: string;
  ironRecipientAddress: string;
  expectedDepositAddress?: string;
  expectedRecipientAddress?: string;
  depositMatch: boolean;
  recipientMatch: boolean;
  routerKeyMatch: boolean;
  failures: string[];
}

const eqHex = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Decode a 32-byte hex value to a 20-byte EVM address (the bytes32 used
 *  as a key in `destinationConfigs.<dst>` is the destination router
 *  pointer, padded with leading zeros). */
function bytes32ToAddress(bytes32: string): string {
  const hex = bytes32.startsWith('0x') ? bytes32.slice(2) : bytes32;
  if (hex.length !== 64) {
    throw new Error(
      `Expected 32-byte hex (64 chars), got ${hex.length}: ${bytes32}`,
    );
  }
  return `0x${hex.slice(24)}`;
}

async function ironRequest<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${IRON_API_BASE}${path}`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Iron API ${path} failed: HTTP ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

/** Discover MCR moonpay autoramps via API, paginating until exhausted.
 *  Filters by `name` containing 'CROSS/moonpay' and excluding 'Inventory'
 *  (those are the sol-XO inventory autoramps, out of scope). */
async function discoverMoonpayMcrAutorampIds(
  apiKey: string,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const qs = cursor
      ? `/autoramps?limit=100&cursor=${encodeURIComponent(cursor)}`
      : '/autoramps?limit=100';
    const page = await ironRequest<IronAutorampListResponse>(qs, apiKey);
    for (const a of page.items ?? []) {
      const name = a.name ?? '';
      if (
        name.includes('CROSS/moonpay') &&
        !name.includes('Inventory') &&
        !seen.has(a.id)
      ) {
        ids.push(a.id);
        seen.add(a.id);
      }
    }
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return ids;
}

interface RegistryArtifacts {
  /** chainName -> warp router (addressOrDenom from moonpay-config.yaml) */
  moonpayRouterByChain: Map<string, string>;
  /** ironbridge deploy doc, indexed by origin chain */
  ironbridgeDeploy: WarpRouteDeployConfig;
}

async function loadRegistryArtifacts(
  warpRouteId: string,
  ironbridgeRouteId: string,
): Promise<RegistryArtifacts> {
  const registry = getRegistry();

  const moonpay = (await registry.getWarpRoute(
    warpRouteId,
  )) as WarpCoreConfig | null;
  if (!moonpay) {
    throw new Error(
      `Could not resolve warp route '${warpRouteId}' from registry at ${registry.getUri()}. ` +
        `Make sure the registry checkout is on the moonpay branch.`,
    );
  }
  const moonpayRouterByChain = new Map<string, string>();
  for (const token of moonpay.tokens) {
    moonpayRouterByChain.set(token.chainName, token.addressOrDenom!);
  }

  const ironbridgeDeploy = (await registry.getWarpDeployConfig(
    ironbridgeRouteId,
  )) as WarpRouteDeployConfig | null;
  if (!ironbridgeDeploy) {
    throw new Error(
      `Could not resolve deploy config '${ironbridgeRouteId}' from registry at ${registry.getUri()}. ` +
        `Expected file: deployments/warp_routes/${ironbridgeRouteId}-deploy.yaml`,
    );
  }

  return { moonpayRouterByChain, ironbridgeDeploy };
}

/** Look up the (depositAddress, decoded-router) pair for a given (origin,
 *  destination) lane in the ironbridge deploy doc. Returns undefined if
 *  the lane isn't configured. */
function lookupLane(
  ironbridgeDeploy: WarpRouteDeployConfig,
  origin: string,
  destination: string,
): { depositAddress: string; routerFromKey: string } | undefined {
  const originCfg = (ironbridgeDeploy as Record<string, unknown>)[origin] as
    | {
        destinationConfigs?: Record<
          string,
          Record<string, { depositAddress: string }>
        >;
      }
    | undefined;
  const destMap = originCfg?.destinationConfigs?.[destination];
  if (!destMap) return undefined;
  const entries = Object.entries(destMap);
  if (entries.length === 0) return undefined;
  if (entries.length > 1) {
    throw new Error(
      `Multiple destination router keys configured for ${origin}->${destination}; ` +
        `this script assumes one router per lane (got ${entries.length}).`,
    );
  }
  const [routerKey, { depositAddress }] = entries[0];
  return { depositAddress, routerFromKey: bytes32ToAddress(routerKey) };
}

function verifyLane(
  autoramp: IronAutoramp,
  artifacts: RegistryArtifacts,
): LaneCheck {
  const failures: string[] = [];

  const ironOriginChain = autoramp.deposit_account.chain;
  const ironDestChain = autoramp.recipient.blockchain;

  const origin = IRON_CHAIN_TO_REGISTRY[ironOriginChain];
  const destination = IRON_CHAIN_TO_REGISTRY[ironDestChain];

  if (!origin || !destination) {
    failures.push(
      `Unrecognised chain on autoramp: deposit=${ironOriginChain} recipient=${ironDestChain}`,
    );
    return {
      autorampId: autoramp.id,
      name: autoramp.name,
      origin: ironOriginChain,
      destination: ironDestChain,
      ironDepositAddress: autoramp.deposit_account.address,
      ironRecipientAddress: autoramp.recipient.address,
      depositMatch: false,
      recipientMatch: false,
      routerKeyMatch: false,
      failures,
    };
  }

  const lane = lookupLane(artifacts.ironbridgeDeploy, origin, destination);
  const moonpayRouter = artifacts.moonpayRouterByChain.get(destination);

  let expectedDepositAddress: string | undefined;
  let expectedRecipientAddress: string | undefined;
  let depositMatch = false;
  let recipientMatch = false;
  let routerKeyMatch = false;

  if (!lane) {
    failures.push(
      `No ironbridge config for lane ${origin}->${destination} (deploy doc missing destinationConfigs entry)`,
    );
  } else {
    expectedDepositAddress = lane.depositAddress;
    depositMatch = eqHex(autoramp.deposit_account.address, lane.depositAddress);
    if (!depositMatch) {
      failures.push(
        `deposit address mismatch: iron=${autoramp.deposit_account.address} ironbridge=${lane.depositAddress}`,
      );
    }
    if (moonpayRouter) {
      routerKeyMatch = eqHex(lane.routerFromKey, moonpayRouter);
      if (!routerKeyMatch) {
        failures.push(
          `router key in ironbridge bytes32 (${lane.routerFromKey}) does not match moonpay router for ${destination} (${moonpayRouter})`,
        );
      }
    }
  }

  if (!moonpayRouter) {
    failures.push(`No moonpay router for destination chain ${destination}`);
  } else {
    expectedRecipientAddress = moonpayRouter;
    recipientMatch = eqHex(autoramp.recipient.address, moonpayRouter);
    if (!recipientMatch) {
      failures.push(
        `recipient mismatch: iron=${autoramp.recipient.address} moonpay-router=${moonpayRouter}`,
      );
    }
  }

  return {
    autorampId: autoramp.id,
    name: autoramp.name,
    origin,
    destination,
    ironDepositAddress: autoramp.deposit_account.address,
    ironRecipientAddress: autoramp.recipient.address,
    expectedDepositAddress,
    expectedRecipientAddress,
    depositMatch,
    recipientMatch,
    routerKeyMatch,
    failures,
  };
}

function printTable(rows: LaneCheck[]): void {
  const headers = ['Autoramp', 'Lane', 'deposit', 'recipient', 'router-key'];
  const data = rows.map((r) => [
    r.name.length > 60 ? `${r.name.slice(0, 57)}...` : r.name,
    `${r.origin} → ${r.destination}`,
    r.depositMatch ? 'PASS' : 'FAIL',
    r.recipientMatch ? 'PASS' : 'FAIL',
    r.routerKeyMatch ? 'PASS' : 'FAIL',
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of data) console.log(fmt(row));
}

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .option('autoramp-ids', {
      type: 'string',
      describe:
        'Comma-separated list of Iron autoramp UUIDs. Skip discovery via Iron API.',
    })
    .option('warp-route-id', {
      type: 'string',
      default: DEFAULT_WARP_ROUTE_ID,
      describe:
        'Registry warp route ID providing destination router addresses.',
    })
    .option('ironbridge-route-id', {
      type: 'string',
      default: DEFAULT_IRONBRIDGE_ROUTE_ID,
      describe:
        'Registry warp deploy ID providing TBA destinationConfigs (depositAddress + router keys).',
    })
    .strict()
    .parseAsync();

  const ironApiKey = process.env.IRON_API_KEY;
  if (!ironApiKey) {
    console.error('IRON_API_KEY env var is required.');
    process.exit(2);
  }

  // Load registry artifacts BEFORE hitting Iron — fails fast on a wrong
  // registry checkout / branch.
  const artifacts = await loadRegistryArtifacts(
    argv.warpRouteId,
    argv.ironbridgeRouteId,
  );

  const autorampIds = argv.autorampIds
    ? argv.autorampIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : await discoverMoonpayMcrAutorampIds(ironApiKey);

  if (autorampIds.length === 0) {
    console.error(
      'No moonpay MCR autoramps found via Iron API. Pass --autoramp-ids explicitly if discovery filter missed them.',
    );
    process.exit(2);
  }

  const checks: LaneCheck[] = [];
  for (const id of autorampIds) {
    const autoramp = await ironRequest<IronAutoramp>(
      `/autoramps/${id}`,
      ironApiKey,
    );
    checks.push(verifyLane(autoramp, artifacts));
  }

  printTable(checks);

  const failed = checks.filter((c) => c.failures.length > 0);
  if (failed.length > 0) {
    console.error('');
    for (const c of failed) {
      console.error(`FAIL ${c.autorampId} (${c.origin} → ${c.destination}):`);
      for (const f of c.failures) console.error(`  - ${f}`);
    }
  }

  console.log('');
  console.log(
    `${checks.length - failed.length} passed, ${failed.length} failed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(2);
});
