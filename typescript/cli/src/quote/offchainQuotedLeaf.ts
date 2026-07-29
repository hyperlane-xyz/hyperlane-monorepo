import {
  DEFAULT_ROUTER_KEY,
  type DerivedCrossCollateralRoutingFeeConfig,
  type DerivedRoutingFeeConfig,
  type DerivedTokenFeeConfig,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

interface OffchainQuotedLeaf {
  address: string;
  destChainName?: string;
  routerKey?: string;
}

function isDerivedRoutingFee(
  cfg: DerivedTokenFeeConfig,
): cfg is DerivedRoutingFeeConfig {
  return cfg.type === TokenFeeType.RoutingFee;
}

function isDerivedCrossCollateralRoutingFee(
  cfg: DerivedTokenFeeConfig,
): cfg is DerivedCrossCollateralRoutingFeeConfig {
  return cfg.type === TokenFeeType.CrossCollateralRoutingFee;
}

export function resolveOffchainQuotedLeafAddress(args: {
  tokenFee: DerivedTokenFeeConfig;
  destChainName: string;
  targetRouterBytes32: string;
}): string {
  const { tokenFee, destChainName, targetRouterBytes32 } = args;
  switch (tokenFee.type) {
    case TokenFeeType.OffchainQuotedLinearFee:
      return tokenFee.address;
    case TokenFeeType.RoutingFee: {
      assert(
        isDerivedRoutingFee(tokenFee),
        `Expected DerivedRoutingFeeConfig shape`,
      );
      const leaf = tokenFee.feeContracts[destChainName];
      assert(leaf, `RoutingFee has no leaf for destination ${destChainName}`);
      assert(
        leaf.type === TokenFeeType.OffchainQuotedLinearFee,
        `RoutingFee leaf at ${destChainName} is ${leaf.type}; only OffchainQuotedLinearFee supports quote signing`,
      );
      return leaf.address;
    }
    case TokenFeeType.CrossCollateralRoutingFee: {
      assert(
        isDerivedCrossCollateralRoutingFee(tokenFee),
        `Expected DerivedCrossCollateralRoutingFeeConfig shape`,
      );
      const destEntries = tokenFee.feeContracts[destChainName];
      assert(
        destEntries,
        `CrossCollateralRoutingFee has no leaves for destination ${destChainName}`,
      );
      const leaf =
        destEntries[targetRouterBytes32] ?? destEntries[DEFAULT_ROUTER_KEY];
      assert(
        leaf,
        `CrossCollateralRoutingFee has no leaf for (${destChainName}, ${targetRouterBytes32}) and no DEFAULT_ROUTER fallback`,
      );
      assert(
        leaf.type === TokenFeeType.OffchainQuotedLinearFee,
        `CrossCollateralRoutingFee leaf for ${destChainName} is ${leaf.type}; only OffchainQuotedLinearFee supports quote signing`,
      );
      return leaf.address;
    }
    default:
      throw new Error(
        `Token fee type ${tokenFee.type} does not support offchain quote signing`,
      );
  }
}

export function enumerateOffchainQuotedLeaves(
  tokenFee: DerivedTokenFeeConfig,
): OffchainQuotedLeaf[] {
  switch (tokenFee.type) {
    case TokenFeeType.OffchainQuotedLinearFee:
      return [{ address: tokenFee.address }];
    case TokenFeeType.RoutingFee: {
      assert(
        isDerivedRoutingFee(tokenFee),
        `Expected DerivedRoutingFeeConfig shape`,
      );
      return Object.entries(tokenFee.feeContracts)
        .filter(
          ([, leaf]) => leaf.type === TokenFeeType.OffchainQuotedLinearFee,
        )
        .map(([destChainName, leaf]) => ({
          destChainName,
          address: leaf.address,
        }));
    }
    case TokenFeeType.CrossCollateralRoutingFee: {
      assert(
        isDerivedCrossCollateralRoutingFee(tokenFee),
        `Expected DerivedCrossCollateralRoutingFeeConfig shape`,
      );
      return Object.entries(tokenFee.feeContracts).flatMap(
        ([destChainName, byRouter]) =>
          Object.entries(byRouter)
            .filter(
              ([, leaf]) => leaf.type === TokenFeeType.OffchainQuotedLinearFee,
            )
            .map(([routerKey, leaf]) => ({
              destChainName,
              routerKey,
              address: leaf.address,
            })),
      );
    }
    default:
      return [];
  }
}
