import {
  type ChainMap,
  type ChainName,
  type WarpCoreConfig,
  altVmChainLookup,
  buildFeeReadContextFromWarpDeployConfig,
} from '@hyperlane-xyz/sdk';
import { hasProtocol } from '@hyperlane-xyz/provider-sdk';
import {
  type StandingWarpQuoteEntry,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
} from '@hyperlane-xyz/provider-sdk/quote';
import { DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY } from '@hyperlane-xyz/provider-sdk/warp';
import { isEVMLike, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logGray } from '../logger.js';
import {
  SUPPORTED_QUOTE_PROTOCOLS,
  createQuoteArtifactManagerForChain,
} from '../quote/factories.js';
import { enumerateOffchainQuotedLeaves } from '../quote/offchainQuotedLeaf.js';
import { deriveWarpRouteConfigForChain } from './warp.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

/**
 * Nested mapping of standing offchain warp quotes, structured to mirror the
 * `RoutingFee` / `CrossCollateralRoutingFee` config layout —
 * `source → destination → targetRouter → recipient → entry`. Sentinel bytes32
 * values are rendered as labels in the output (`TARGET_ROUTER_NONE`,
 * `DEFAULT_CROSS_COLLATERAL_ROUTER`, `WILDCARD_RECIPIENT`) for readability;
 * non-sentinel addresses surface as-is.
 */
export type WarpQuoteReadResult = ChainMap<
  Record<
    string, // destination chain name (or domain id if unknown)
    Record<
      string, // targetRouter: TARGET_ROUTER_NONE | DEFAULT_CROSS_COLLATERAL_ROUTER | bytes32 hex
      Record<
        string, // recipient: WILDCARD_RECIPIENT | bytes32 hex
        QuoteEntry
      >
    >
  >
>;

interface QuoteEntry {
  amount: string; // "wildcard" or decimal string
  maxFee: string;
  halfAmount: string;
  issuedAt: string; // ISO 8601 UTC (derived from on-chain unix timestamp)
  expiry: string; // ISO 8601 UTC
  expired: boolean; // true when on-chain `expiry` is in the past
}

export async function runWarpQuoteRead({
  context,
  warpRouteId,
  chain,
}: {
  context: CommandContext;
  warpRouteId: string;
  chain?: ChainName;
}): Promise<WarpQuoteReadResult> {
  const { multiProvider } = context;

  const warpCoreConfig = await getWarpCoreConfigOrExit({
    context,
    warpRouteId,
  });

  const requestedChains = chain
    ? [chain]
    : warpCoreConfig.tokens.map((t) => t.chainName);

  // Two-stage gate: (1) protocol must be registered (or EVM-like) so downstream
  // calls don't crash; (2) protocol must be in the quote factory's supported
  // set. Stage 1 is the broader safety net; stage 2 is what this command can
  // actually serve.
  const targetChains: ChainName[] = [];
  for (const c of requestedChains) {
    const protocol = multiProvider.getProtocol(c);
    if (!isEVMLike(protocol) && !hasProtocol(protocol)) {
      logGray(
        `Skipping ${c} — no provider registered for protocol ${protocol}`,
      );
      continue;
    }
    if (!SUPPORTED_QUOTE_PROTOCOLS.has(protocol)) {
      logGray(
        `Skipping ${c} — warp quote not supported for protocol ${protocol}`,
      );
      continue;
    }
    targetChains.push(c);
  }

  const chainLookup = altVmChainLookup(multiProvider);

  const perChain = await promiseObjAll(
    Object.fromEntries(
      targetChains.map((c) => [
        c,
        readChainQuotes({
          context,
          warpCoreConfig,
          chain: c,
          chainLookup,
        }),
      ]),
    ),
  );

  return objMap(perChain, (_chainName, entries) =>
    groupEntriesByScope(entries, multiProvider),
  );
}

async function readChainQuotes(args: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
  chain: ChainName;
  chainLookup: ReturnType<typeof altVmChainLookup>;
}): Promise<StandingWarpQuoteEntry[]> {
  const { context, warpCoreConfig, chain, chainLookup } = args;
  const { multiProvider } = context;

  const routerAddress = warpCoreConfig.tokens.find(
    (t) => t.chainName === chain,
  )?.addressOrDenom;
  if (!routerAddress) {
    logGray(`Skipping ${chain} — no router address in warp config`);
    return [];
  }

  const localConfig = await deriveWarpRouteConfigForChain(
    context,
    chain,
    routerAddress,
  );
  if (!localConfig.tokenFee) {
    logGray(`Skipping ${chain} — no tokenFee deployed`);
    return [];
  }

  const leaves = enumerateOffchainQuotedLeaves(localConfig.tokenFee);
  if (leaves.length === 0) {
    logGray(
      `Skipping ${chain} — no OffchainQuotedLinearFee leaves in tokenFee`,
    );
    return [];
  }

  const feeReadContext = buildFeeReadContextFromWarpDeployConfig(
    localConfig,
    chainLookup,
  );
  const chainMetadata = chainLookup.getChainMetadata(chain);

  // EVM and SVM have structurally different fee-program layouts and the
  // iteration must match:
  //   - EVM CC deploys a SEPARATE leaf contract per router key. Each leaf
  //     stores `quotes(dest, recipient)` with no on-chain target_router
  //     dimension, so the reader returns entries tagged TARGET_ROUTER_NONE.
  //     We iterate per leaf and stamp `leaf.routerKey` on the entries so
  //     sibling CC leaves don't collide at the same (dest, recipient).
  //   - SVM CC is one fee program with internal PDA routing. The reader
  //     derives target_router from PDA seeds and returns the full set
  //     in one call. We dedup leaves by address so we don't fire the same
  //     reader N times for the same program.
  const entries: StandingWarpQuoteEntry[] = [];
  if (isEVMLike(chainMetadata.protocol)) {
    for (const leaf of leaves) {
      const manager = createQuoteArtifactManagerForChain({
        chainMetadata,
        feeAddress: leaf.address,
        context: feeReadContext,
        multiProvider,
      });
      if (!manager) return [];
      const leafEntries = await manager.createReader().readStandingQuotes();
      if (leaf.routerKey) {
        const routerKey = leaf.routerKey;
        for (const e of leafEntries) {
          entries.push({
            ...e,
            scope: { ...e.scope, targetRouter: routerKey },
          });
        }
      } else {
        entries.push(...leafEntries);
      }
    }
  } else {
    const uniqueAddresses = new Set(leaves.map((l) => l.address));
    for (const address of uniqueAddresses) {
      const manager = createQuoteArtifactManagerForChain({
        chainMetadata,
        feeAddress: address,
        context: feeReadContext,
        multiProvider,
      });
      if (!manager) return [];
      entries.push(...(await manager.createReader().readStandingQuotes()));
    }
  }
  return entries;
}

function targetRouterLabel(hex: string): string {
  if (hex === WARP_TARGET_ROUTER_NONE) return 'TARGET_ROUTER_NONE';
  if (hex === DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY) {
    return 'DEFAULT_CROSS_COLLATERAL_ROUTER';
  }
  return hex;
}

function recipientLabel(hex: string): string {
  return hex === WILDCARD_BYTES32 ? 'WILDCARD_RECIPIENT' : hex;
}

export function groupEntriesByScope(
  entries: StandingWarpQuoteEntry[],
  multiProvider: { tryGetChainName: (domain: number) => ChainName | null },
): WarpQuoteReadResult[ChainName] {
  const nowSec = Math.floor(Date.now() / 1000);
  const grouped: WarpQuoteReadResult[ChainName] = {};
  for (const entry of entries) {
    const destKey =
      multiProvider.tryGetChainName(entry.scope.destination) ??
      String(entry.scope.destination);
    const byRouter = (grouped[destKey] ??= {});
    const byRecipient = (byRouter[
      targetRouterLabel(entry.scope.targetRouter)
    ] ??= {});
    byRecipient[recipientLabel(entry.scope.recipient)] = {
      amount:
        entry.scope.amount.kind === 'wildcard'
          ? 'wildcard'
          : entry.scope.amount.value.toString(),
      maxFee: entry.params.maxFee.toString(),
      halfAmount: entry.params.halfAmount.toString(),
      issuedAt: unixSecToIsoString(entry.issuedAt),
      expiry: unixSecToIsoString(entry.expiry),
      expired: nowSec > entry.expiry,
    };
  }
  return grouped;
}

function unixSecToIsoString(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}
