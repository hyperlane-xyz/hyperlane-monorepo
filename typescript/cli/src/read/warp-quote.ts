import {
  buildFeeReadContextFromWarpArtifactConfig,
  warpConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  type ChainMap,
  type ChainName,
  type WarpCoreConfig,
  altVmChainLookup,
  validateWarpConfigForAltVM,
} from '@hyperlane-xyz/sdk';
import { hasProtocol } from '@hyperlane-xyz/provider-sdk';
import { isEVMLike, objMap, promiseObjAll } from '@hyperlane-xyz/utils';
import { type StandingWarpQuoteEntry } from '@hyperlane-xyz/provider-sdk/quote';

import { type CommandContext } from '../context/types.js';
import { logGray } from '../logger.js';
import { createQuoteArtifactManagerForChain } from '../quote/factories.js';
import { enumerateOffchainQuotedLeaves } from '../quote/offchainQuotedLeaf.js';
import { deriveWarpRouteConfigForChain } from './warp.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

/**
 * Nested mapping of standing offchain warp quotes, structured to mirror the
 * `RoutingFee` / `CrossCollateralRoutingFee` config layout —
 * `source → destination → targetRouter → recipient → entry` — so a YAML
 * dump makes it obvious which routers/recipients are covered. Sentinel
 * bytes32 values surface as-is (target_router NONE = `0x00..00`, recipient
 * WILDCARD = `0xff..ff`, default-router key = its keccak constant) to match
 * how the deploy config writes them.
 */
export type WarpQuoteReadResult = ChainMap<
  Record<
    string, // destination chain name (or domain id if unknown)
    Record<
      string, // targetRouter bytes32 hex (NONE / specific / DEFAULT_ROUTER_KEY)
      Record<
        string, // recipient bytes32 hex (WILDCARD or specific)
        QuoteEntry
      >
    >
  >
>;

interface QuoteEntry {
  amount: string; // "wildcard" or decimal string
  maxFee: string;
  halfAmount: string;
  issuedAt: number;
  expiry: number;
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

  const candidateChains = warpCoreConfig.tokens
    .map((t) => t.chainName)
    .filter(
      (c) =>
        isEVMLike(multiProvider.getProtocol(c)) ||
        hasProtocol(multiProvider.getProtocol(c)),
    );

  const targetChains = chain ? [chain] : candidateChains;
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

  const validated = validateWarpConfigForAltVM(localConfig, chain);
  const { config: warpArtifact } = warpConfigToArtifact(validated, chainLookup);
  const feeReadContext =
    buildFeeReadContextFromWarpArtifactConfig(warpArtifact);
  const chainMetadata = chainLookup.getChainMetadata(chain);

  const entries: StandingWarpQuoteEntry[] = [];
  for (const leaf of leaves) {
    const manager = createQuoteArtifactManagerForChain({
      chainMetadata,
      feeAddress: leaf.address,
      context: feeReadContext,
      multiProvider,
    });
    if (!manager) {
      logGray(
        `Skipping ${chain} — warp quote support unavailable (protocol ${chainMetadata.protocol})`,
      );
      return [];
    }
    entries.push(...(await manager.createReader().readStandingQuotes()));
  }
  return entries;
}

function groupEntriesByScope(
  entries: StandingWarpQuoteEntry[],
  multiProvider: { tryGetChainName: (domain: number) => ChainName | null },
): WarpQuoteReadResult[ChainName] {
  const grouped: WarpQuoteReadResult[ChainName] = {};
  for (const entry of entries) {
    const destKey =
      multiProvider.tryGetChainName(entry.scope.destination) ??
      String(entry.scope.destination);
    const byRouter = (grouped[destKey] ??= {});
    const byRecipient = (byRouter[entry.scope.targetRouter] ??= {});
    byRecipient[entry.scope.recipient] = {
      amount:
        entry.scope.amount.kind === 'wildcard'
          ? 'wildcard'
          : entry.scope.amount.value.toString(),
      maxFee: entry.params.maxFee.toString(),
      halfAmount: entry.params.halfAmount.toString(),
      issuedAt: entry.issuedAt,
      expiry: entry.expiry,
    };
  }
  return grouped;
}
