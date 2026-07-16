import { type ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
  type WarpQuoteAmount,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import { DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY } from '@hyperlane-xyz/provider-sdk/warp';
import {
  type ChainName,
  type DerivedTokenFeeConfig,
  type MultiProvider,
  TokenFeeType,
  altVmChainLookup,
  buildFeeReadContextFromWarpDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  assert,
  isNullish,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen, warnYellow } from '../logger.js';
import {
  createDefaultQuoteSignerForChain,
  createQuoteArtifactManagerForChain,
  resolveTxSignerForChain,
} from '../quote/factories.js';
import { resolveOffchainQuotedLeafAddress } from '../quote/offchainQuotedLeaf.js';
import { deriveWarpRouteConfigForChain } from '../read/warp.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

function parseBigIntFlag(name: string, raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid bigint value for --${name}: "${raw}"`);
  }
}

export async function runWarpQuoteCreate({
  context,
  warpRouteId,
  chain,
  destination,
  recipient,
  amount,
  maxFee,
  halfAmount,
  ttl,
  quoteSignerKey,
  targetRouter: explicitTargetRouter,
}: {
  context: WriteCommandContext;
  warpRouteId: string;
  chain: ChainName;
  destination: string;
  recipient: string;
  amount: string;
  maxFee: string;
  halfAmount: string;
  ttl: number;
  quoteSignerKey: string;
  targetRouter?: string;
}): Promise<void> {
  const { multiProvider, altVmSigners } = context;

  const warpCoreConfig = await getWarpCoreConfigOrExit({
    context,
    warpRouteId,
  });

  const destinationChainName = resolveDestinationChainName(
    destination,
    multiProvider,
  );
  const destinationDomain = multiProvider.getDomainId(destinationChainName);
  const destinationProtocol = multiProvider.getProtocol(destinationChainName);

  const localRouterAddress = warpCoreConfig.tokens.find(
    (t) => t.chainName === chain,
  )?.addressOrDenom;
  assert(
    localRouterAddress,
    `No warp router address found in warp config for chain ${chain}`,
  );

  const localConfig = await deriveWarpRouteConfigForChain(
    context,
    chain,
    localRouterAddress,
  );
  assert(
    localConfig.tokenFee,
    `No tokenFee deployed for warp route ${warpRouteId} on ${chain}`,
  );

  const chainLookup = altVmChainLookup(multiProvider);
  const feeReadContext = buildFeeReadContextFromWarpDeployConfig(
    localConfig,
    chainLookup,
  );

  // knownRoutersPerDomain unions remoteRouters and crossCollateralRouters.
  assert(
    feeReadContext.knownRoutersPerDomain[destinationDomain],
    `Destination ${destinationChainName} (domain ${destinationDomain}) is not enrolled in warp route ${warpRouteId} on ${chain}`,
  );

  const targetRouter = resolveTargetRouterForVariant({
    tokenFee: localConfig.tokenFee,
    localConfig,
    multiProvider,
    destinationChainName,
    destinationDomain,
    destinationProtocol,
    explicitTargetRouter,
  });

  const feeAddress = resolveOffchainQuotedLeafAddress({
    tokenFee: localConfig.tokenFee,
    destChainName: destinationChainName,
    targetRouterBytes32: targetRouter,
  });

  const recipientBytes32 =
    recipient === WarpQuoteAmountKind.wildcard
      ? WILDCARD_BYTES32
      : addressToBytes32(recipient, destinationProtocol);

  const quoteAmount: WarpQuoteAmount =
    amount === WarpQuoteAmountKind.wildcard
      ? WARP_QUOTE_AMOUNT_WILDCARD
      : {
          kind: WarpQuoteAmountKind.value,
          value: parseBigIntFlag('amount', amount),
        };

  const chainMetadata = chainLookup.getChainMetadata(chain);
  const manager = createQuoteArtifactManagerForChain({
    chainMetadata,
    feeAddress,
    context: feeReadContext,
    multiProvider,
  });
  assert(
    manager,
    `Warp quote support is not available for chain ${chain} (protocol ${chainMetadata.protocol})`,
  );
  const quoteSigner = createDefaultQuoteSignerForChain(
    chainMetadata,
    quoteSignerKey,
  );
  assert(
    quoteSigner,
    `Warp quote signing is not available for chain ${chain} (protocol ${chainMetadata.protocol})`,
  );
  const txSigner = resolveTxSignerForChain({
    chainMetadata,
    multiProvider,
    altVmSigners,
  });

  const writer = manager.createWriter(quoteSigner, txSigner);

  const issuedAt = Math.floor(Date.now() / 1000);
  // Reject ttl=0 (transient quotes): standalone `warp quote create` writes a
  // transient quote that no later tx can consume — EVM clears it via EIP-1153
  // at end of the create tx; SVM's transient PDA is scoped by a client salt
  // generated internally and never returned to the caller.
  assert(
    ttl > 0,
    `--ttl must be > 0 (transient quotes are unusable from standalone create), got ${ttl}`,
  );
  const expiry = issuedAt + ttl;

  logBlue(
    `Submitting standing warp quote on ${chain} ⇒ ${destinationChainName} (domain ${destinationDomain})…`,
  );
  const result = await writer.submitQuote({
    scope: {
      destination: destinationDomain,
      recipient: recipientBytes32,
      targetRouter,
      amount: quoteAmount,
    },
    params: {
      maxFee: parseBigIntFlag('max-fee', maxFee),
      halfAmount: parseBigIntFlag('half-amount', halfAmount),
    },
    issuedAt,
    expiry,
  });

  if (result.standingStored === false) {
    warnYellow(
      `⚠️  On-chain no-op: a standing quote with an equal or newer issuedAt already exists for this scope, so this submission did not overwrite it. Re-run with a later issuedAt (wait a second and retry) to apply changed params.`,
    );
  }

  logGreen(`✅ Quote submitted`);
  log(`   txHash:    ${result.txHash}`);
  log(`   signature: ${result.signature}`);
}

function resolveDestinationChainName(
  destination: string,
  multiProvider: { getChainName: (input: string | number) => string },
): string {
  const numericDomain = Number(destination);
  if (Number.isFinite(numericDomain) && String(numericDomain) === destination) {
    return multiProvider.getChainName(numericDomain);
  }
  return destination;
}

// Resolves the entry for a destination in a chainName-or-domain keyed record,
// mirroring how remoteRouters and crossCollateralRouters are keyed in the warp
// deploy config.
function findByDestination<T>(
  record: Record<string, T> | undefined,
  destinationChainName: string,
  destinationDomain: number,
  multiProvider: MultiProvider,
): T | undefined {
  if (!record) return undefined;
  const entry = Object.entries(record).find(([key]) => {
    const domain = multiProvider.tryGetDomainId(key);
    if (!isNullish(domain)) return domain === destinationDomain;
    return key === destinationChainName;
  });
  return entry?.[1];
}

export function resolveTargetRouterForVariant(args: {
  tokenFee: DerivedTokenFeeConfig;
  localConfig: {
    remoteRouters?: Record<string, { address: string }>;
    crossCollateralRouters?: Record<string, string[]>;
  };
  multiProvider: MultiProvider;
  destinationChainName: string;
  destinationDomain: number;
  destinationProtocol: ProtocolType;
  explicitTargetRouter?: string;
}): string {
  const {
    tokenFee,
    localConfig,
    multiProvider,
    destinationChainName,
    destinationDomain,
    destinationProtocol,
    explicitTargetRouter,
  } = args;
  switch (tokenFee.type) {
    case TokenFeeType.LinearFee:
    case TokenFeeType.RegressiveFee:
    case TokenFeeType.ProgressiveFee:
    case TokenFeeType.OffchainQuotedLinearFee:
    case TokenFeeType.RoutingFee:
      return WARP_TARGET_ROUTER_NONE;

    case TokenFeeType.CrossCollateralRoutingFee: {
      // SVM submit_quote does NO cascade — the signed targetRouter must match an
      // actually-configured route key on the fee account. EVM cascades at
      // quote-read time, so it's tolerant of either specific or DEFAULT here.
      const destRoutes = tokenFee.feeContracts[destinationChainName] ?? {};

      // Explicit override: user targets a specific router-keyed leaf.
      if (explicitTargetRouter) {
        const bytes32 = addressToBytes32(
          explicitTargetRouter,
          destinationProtocol,
        );
        assert(
          destRoutes[bytes32],
          `--target-router ${explicitTargetRouter} has no CrossCollateralRoutingFee leaf on ${destinationChainName} (domain ${destinationDomain}). Configured router keys: ${
            Object.keys(destRoutes).join(', ') || '(none)'
          }`,
        );
        return bytes32;
      }

      // Prefer the destination's canonical remoteRouter when it has a leaf.
      const remoteRouter = findByDestination(
        localConfig.remoteRouters,
        destinationChainName,
        destinationDomain,
        multiProvider,
      );
      if (remoteRouter) {
        const bytes32 = addressToBytes32(
          remoteRouter.address,
          destinationProtocol,
        );
        if (destRoutes[bytes32]) return bytes32;
      }

      // Otherwise consult the destination's crossCollateralRouters.
      const ccRouters =
        findByDestination(
          localConfig.crossCollateralRouters,
          destinationChainName,
          destinationDomain,
          multiProvider,
        ) ?? [];
      const ccMatches = ccRouters
        .map((address) => addressToBytes32(address, destinationProtocol))
        .filter((bytes32) => destRoutes[bytes32]);
      if (ccMatches.length === 1) return ccMatches[0];
      if (ccMatches.length > 1) {
        throw new Error(
          `CrossCollateralRoutingFee has multiple router-keyed leaves for ${destinationChainName} (domain ${destinationDomain}); pass --target-router to choose one. Matching router keys: ${ccMatches.join(
            ', ',
          )}`,
        );
      }

      // DEFAULT fallback.
      if (destRoutes[DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]) {
        return DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY;
      }

      throw new Error(
        `CrossCollateralRoutingFee has no leaf for destination ${destinationChainName} (domain ${destinationDomain}) — pass --target-router to target a specific router-keyed leaf, or configure a DEFAULT_ROUTER fallback`,
      );
    }

    default: {
      const _exhaustive: never = tokenFee;
      throw new Error(
        `Unhandled fee type in resolveTargetRouterForVariant: ${stringifyObject(
          _exhaustive,
          'json',
        )}`,
      );
    }
  }
}
