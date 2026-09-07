/**
 * Verifies Iron autoramps for `CROSS/moonpay` (USDC + USDT iron bridges)
 * against the registry. Per-lane checks:
 *
 *   A. iron.deposit_account.address
 *      == ctusd-ironbridge.<src>.destinationConfigs.<dst>.<routerKey>.depositAddress
 *   B. iron.recipient.address
 *      == decode(routerKey)        // bytes32 -> 20-byte EVM address
 *   C. iron.recipient.address
 *      == warp-route token where chainName=<dst>
 *
 * USDC iron bridge (6 lanes): USDC/moonpay as router source of truth.
 * USDT iron bridge (2 lanes): merges USDC/moonpay (citrea router) +
 *   USDT/moonpay (ethereum router) as router source of truth.
 *
 * Source of truth files read via `getRegistry()` from the local registry
 * checkout — `<monorepo>/../../hyperlane-registry`. No RPC, no GitHub fetch.
 *
 * Required env: IRON_API_KEY
 */

// Load `IRON_API_KEY` (and any other env) from `typescript/infra/.env`
// when present. The file is gitignored. Falls back silently to the
// real environment when there's no `.env`.
import 'dotenv/config';

import type { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { bytes32ToAddress, eqAddress } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';

const IRON_API_BASE = 'https://api.iron.xyz/api';

// The six MCR autoramps for the USDC iron bridge (arb / base / ethereum USDC ↔
// citrea ctUSD). Hardcoded rather than discovered via Iron's listing endpoint
// so the script's expected scope is explicit + grepable.
// Inventory autoramps (sol XO ↔ EVM USDC) are intentionally NOT in this
// list — they have a different recipient (operator inventory wallet, not
// a warp router) and are out of scope for this verifier.
const USDC_IRONBRIDGE_AUTORAMP_IDS = [
  '019e02ea-d0b9-7967-8475-3249a4990204', // Mint   arbitrum USDC -> citrea ctUSD
  '019e02ec-6416-7331-bd86-f01bc4309770', // Mint   base USDC     -> citrea ctUSD
  '019e02ec-d5b3-771e-9318-c692c0047064', // Mint   ethereum USDC -> citrea ctUSD
  '019e02ed-a694-753f-b848-7f40da70e5fc', // Redeem citrea ctUSD  -> arbitrum USDC
  '019e02ee-60c3-72e2-a75a-70666c6224b3', // Redeem citrea ctUSD  -> base USDC
  '019e02ee-f696-78fe-9d79-6165e010fa09', // Redeem citrea ctUSD  -> ethereum USDC
];

// The two MCR autoramps for the USDT iron bridge (ethereum USDT ↔ citrea ctUSD).
// Recipient for eth->citrea is the citrea router in USDC/moonpay; recipient for
// citrea->eth is the ethereum router in USDT/moonpay.
const USDT_IRONBRIDGE_AUTORAMP_IDS = [
  '019e0749-766f-7149-b1ed-e3904b9e2bbe', // Mint   ethereum USDT -> citrea ctUSD
  '019e0762-ea8e-72b3-a2ee-70eaa6faaa5f', // Redeem citrea ctUSD  -> ethereum USDT
];

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

interface RegistryArtifacts {
  /** chainName -> warp router (addressOrDenom from moonpay-config.yaml) */
  moonpayRouterByChain: Map<string, string>;
  /** ironbridge deploy doc, indexed by origin chain */
  ironbridgeDeploy: WarpRouteDeployConfig;
}

async function loadRegistryArtifacts(
  warpRouteIds: string[],
  ironbridgeRouteId: string,
): Promise<RegistryArtifacts> {
  const registry = getRegistry();
  const moonpayRouterByChain = new Map<string, string>();

  for (const warpRouteId of warpRouteIds) {
    const route = (await registry.getWarpRoute(
      warpRouteId,
    )) as WarpCoreConfig | null;
    if (!route) {
      throw new Error(
        `Could not resolve warp route '${warpRouteId}' from registry at ${registry.getUri()}. ` +
          `Make sure the registry checkout is on the moonpay branch.`,
      );
    }
    for (const token of route.tokens) {
      moonpayRouterByChain.set(token.chainName, token.addressOrDenom!);
    }
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
    depositMatch = eqAddress(
      autoramp.deposit_account.address,
      lane.depositAddress,
    );
    if (!depositMatch) {
      failures.push(
        `deposit address mismatch: iron=${autoramp.deposit_account.address} ironbridge=${lane.depositAddress}`,
      );
    }
    if (moonpayRouter) {
      routerKeyMatch = eqAddress(lane.routerFromKey, moonpayRouter);
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
    recipientMatch = eqAddress(autoramp.recipient.address, moonpayRouter);
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
  const ironApiKey = process.env.IRON_API_KEY;
  if (!ironApiKey) {
    console.error('IRON_API_KEY env var is required.');
    process.exit(2);
  }

  // Load registry artifacts BEFORE hitting Iron — fails fast on a wrong
  // registry checkout / branch.
  const usdcArtifacts = await loadRegistryArtifacts(
    ['USDC/moonpay'],
    'CROSS/ctusd-usdc-ironbridge',
  );
  // USDT iron bridge recipients span two routes: citrea router lives in
  // USDC/moonpay; ethereum router lives in USDT/moonpay.
  const usdtArtifacts = await loadRegistryArtifacts(
    ['USDC/moonpay', 'USDT/moonpay'],
    'CROSS/ctusd-usdt-ironbridge',
  );

  const checks: LaneCheck[] = [];

  console.log('=== USDC iron bridge ===');
  for (const id of USDC_IRONBRIDGE_AUTORAMP_IDS) {
    const autoramp = await ironRequest<IronAutoramp>(
      `/autoramps/${id}`,
      ironApiKey,
    );
    checks.push(verifyLane(autoramp, usdcArtifacts));
  }
  printTable(checks.slice(0, USDC_IRONBRIDGE_AUTORAMP_IDS.length));

  console.log('');
  console.log('=== USDT iron bridge ===');
  const usdtChecks: LaneCheck[] = [];
  for (const id of USDT_IRONBRIDGE_AUTORAMP_IDS) {
    const autoramp = await ironRequest<IronAutoramp>(
      `/autoramps/${id}`,
      ironApiKey,
    );
    usdtChecks.push(verifyLane(autoramp, usdtArtifacts));
  }
  checks.push(...usdtChecks);
  printTable(usdtChecks);

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
