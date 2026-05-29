import { type ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
  type WarpQuoteAmount,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import {
  buildFeeReadContextFromWarpArtifactConfig,
  warpConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  type ChainName,
  TokenFeeType,
  type WarpCoreConfig,
  altVmChainLookup,
  validateWarpConfigForAltVM,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen } from '../logger.js';
import {
  createDefaultQuoteSignerForChain,
  createQuoteArtifactManagerForChain,
} from '../quote/factories.js';
import { resolveOffchainQuotedLeafAddress } from '../quote/offchainQuotedLeaf.js';
import { deriveWarpRouteConfigForChain } from '../read/warp.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

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
  const feeVariant = localConfig.tokenFee.type;

  const targetRouter = resolveTargetRouterForVariant({
    feeVariant,
    warpCoreConfig,
    destinationChainName,
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
      : { kind: WarpQuoteAmountKind.value, value: BigInt(amount) };

  const chainLookup = altVmChainLookup(multiProvider);
  const chainMetadata = chainLookup.getChainMetadata(chain);
  const validatedConfig = validateWarpConfigForAltVM(localConfig, chain);
  const { config: warpArtifact } = warpConfigToArtifact(
    validatedConfig,
    chainLookup,
  );
  const manager = createQuoteArtifactManagerForChain({
    chainMetadata,
    feeAddress,
    context: buildFeeReadContextFromWarpArtifactConfig(warpArtifact),
    multiProvider,
    altVmSigners,
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

  const writer = manager.createWriter(quoteSigner);

  const issuedAt = Math.floor(Date.now() / 1000);
  assert(ttl >= 0, `--ttl must be >= 0, got ${ttl}`);
  const expiry = issuedAt + ttl;

  logBlue(
    `Submitting ${
      ttl === 0 ? 'transient' : 'standing'
    } warp quote on ${chain} ⇒ ${destinationChainName} (domain ${destinationDomain})…`,
  );
  const result = await writer.submitQuote({
    scope: {
      destination: destinationDomain,
      recipient: recipientBytes32,
      targetRouter,
      amount: quoteAmount,
    },
    params: { maxFee: BigInt(maxFee), halfAmount: BigInt(halfAmount) },
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

function resolveTargetRouterForVariant(args: {
  feeVariant: TokenFeeType;
  warpCoreConfig: WarpCoreConfig;
  destinationChainName: string;
  destinationProtocol: ProtocolType;
}): string {
  const {
    feeVariant,
    warpCoreConfig,
    destinationChainName,
    destinationProtocol,
  } = args;
  switch (feeVariant) {
    case TokenFeeType.LinearFee:
    case TokenFeeType.RegressiveFee:
    case TokenFeeType.ProgressiveFee:
    case TokenFeeType.OffchainQuotedLinearFee:
    case TokenFeeType.RoutingFee:
      return WARP_TARGET_ROUTER_NONE;

    case TokenFeeType.CrossCollateralRoutingFee: {
      const destToken = warpCoreConfig.tokens.find(
        (t) => t.chainName === destinationChainName,
      );
      assert(
        destToken?.addressOrDenom,
        `No router address found in warp config for destination ${destinationChainName}`,
      );
      return addressToBytes32(destToken.addressOrDenom, destinationProtocol);
    }
  }
}
