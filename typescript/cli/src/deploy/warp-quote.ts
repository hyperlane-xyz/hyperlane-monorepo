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
import { addressToBytes32, assert, isNullish } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen } from '../logger.js';
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
  });

  const feeAddress = resolveOffchainQuotedLeafAddress({
    tokenFee: localConfig.tokenFee,
    destChainName: destinationChainName,
    targetRouterBytes32: targetRouter,
  });

  const recipientBytes32 =
    recipient === 'wildcard'
      ? WILDCARD_BYTES32
      : addressToBytes32(recipient, destinationProtocol);

  const quoteAmount: WarpQuoteAmount =
    amount === 'wildcard'
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

export function resolveTargetRouterForVariant(args: {
  tokenFee: DerivedTokenFeeConfig;
  localConfig: { remoteRouters?: Record<string, { address: string }> };
  multiProvider: MultiProvider;
  destinationChainName: string;
  destinationDomain: number;
  destinationProtocol: ProtocolType;
}): string {
  const {
    tokenFee,
    localConfig,
    multiProvider,
    destinationChainName,
    destinationDomain,
    destinationProtocol,
  } = args;
  switch (tokenFee.type) {
    case TokenFeeType.LinearFee:
    case TokenFeeType.RegressiveFee:
    case TokenFeeType.ProgressiveFee:
    case TokenFeeType.OffchainQuotedLinearFee:
    case TokenFeeType.RoutingFee:
      return WARP_TARGET_ROUTER_NONE;

    case TokenFeeType.CrossCollateralRoutingFee: {
      // SVM submit_quote does NO cascade — the signed targetRouter must
      // match an actually-configured route key on the fee account.
      // EVM cascades at quote-read time, so it's tolerant of either
      // specific or DEFAULT here. Prefer a specific match, fall back to
      // DEFAULT_ROUTER_KEY.
      const destRoutes = tokenFee.feeContracts[destinationChainName] ?? {};
      const routers = localConfig.remoteRouters ?? {};
      const routerEntry = Object.entries(routers).find(([key]) => {
        const domain = multiProvider.tryGetDomainId(key);
        if (!isNullish(domain)) return domain === destinationDomain;
        return key === destinationChainName;
      });
      if (routerEntry) {
        const destRouterBytes32 = addressToBytes32(
          routerEntry[1].address,
          destinationProtocol,
        );
        if (destRoutes[destRouterBytes32]) return destRouterBytes32;
      }
      if (destRoutes[DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]) {
        return DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY;
      }
      throw new Error(
        `CrossCollateralRoutingFee has no leaf for destination ${destinationChainName} (domain ${destinationDomain}) — neither a specific router-keyed leaf nor a DEFAULT_ROUTER fallback is configured`,
      );
    }
  }
}
