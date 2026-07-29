import {
  ChainMap,
  ChainName,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  MovableTokenConfig,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addressToBytes32,
  arrayToObject,
  assert,
  intersection,
  objMap,
} from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { usdcTokenAddresses } from '../cctp.js';
import { usdtTokenAddresses } from '../tokens.js';
import { WarpRouteIds } from '../warpIds.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

type RebalancingConfig = Required<
  Pick<MovableTokenConfig, 'allowedRebalancingBridges' | 'allowedRebalancers'>
>;

type CCTPWarpRouteId =
  | WarpRouteIds.MainnetCCTPV1
  | WarpRouteIds.MainnetCCTPV2Standard
  | WarpRouteIds.MainnetCCTPV2Fast;

export function getUSDCRebalancingBridgesConfigFor(
  deploymentChains: readonly ChainName[],
  warpRouteIds: [CCTPWarpRouteId, ...CCTPWarpRouteId[]],
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();

  // Fetch all warp routes and build bridge mappings
  const routeData = warpRouteIds.map((warpRouteId) => {
    const route = registry.getWarpRoute(warpRouteId);
    assert(route, `Warp route ${warpRouteId} not found`);

    const chainSet = new Set(route.tokens.map(({ chainName }) => chainName));
    const bridgesByChain = Object.fromEntries(
      route.tokens.map(({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected bridge address for ${warpRouteId} on ${chainName}`,
        );
        return [chainName, addressOrDenom];
      }),
    );

    return { chainSet, bridgesByChain };
  });

  // Intersection: only chains present in ALL routes
  const deploymentSet = new Set(deploymentChains);
  const chainSets = routeData.map(({ chainSet }) => chainSet);
  const allSets = [deploymentSet, ...chainSets];
  const rebalanceableChains = [
    ...allSets.reduce((acc, set) => intersection(acc, set)),
  ];

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      // Collect bridges from all routes for this chain
      const bridges = routeData.map(({ bridgesByChain }) => {
        const bridge = bridgesByChain[currentChain];
        assert(bridge, `No bridge found for chain ${currentChain}`);
        return { bridge };
      });

      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => [String(getDomainId(remoteChain)), bridges]),
      );

      return {
        allowedRebalancers: [REBALANCER],
        allowedRebalancingBridges,
      };
    },
  );
}

export const getRebalancingUSDCConfigForChain = (
  currentChain: keyof typeof usdcTokenAddresses,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: ChainMap<Address>,
  rebalancingConfigByChain: ChainMap<RebalancingConfig>,
  tokenFee?: TokenFeeConfigInput,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  const usdcTokenAddress = usdcTokenAddresses[currentChain];
  assert(
    usdcTokenAddress,
    `USDC token address not found for chain ${currentChain}`,
  );

  const currentRebalancingConfig = rebalancingConfigByChain[currentChain];
  assert(
    currentRebalancingConfig,
    `Rebalancing config not found for chain ${currentChain}`,
  );

  const { allowedRebalancers, allowedRebalancingBridges } =
    currentRebalancingConfig;

  return {
    type: TokenType.collateral,
    token: usdcTokenAddress,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
    allowedRebalancers,
    allowedRebalancingBridges,
    tokenFee,
  };
};

export function getRebalancingBridgesConfigFor(
  deploymentChains: readonly ChainName[],
  warpRouteIds: [WarpRouteIds, ...WarpRouteIds[]],
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();

  const routeData = warpRouteIds.map((warpRouteId) => {
    const route = registry.getWarpRoute(warpRouteId);
    assert(route, `Warp route ${warpRouteId} not found`);

    const chainSet = new Set(route.tokens.map(({ chainName }) => chainName));
    const bridgesByChain = Object.fromEntries(
      route.tokens.map(({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected bridge address for ${warpRouteId} on ${chainName}`,
        );
        return [chainName, addressOrDenom];
      }),
    );

    return { chainSet, bridgesByChain };
  });

  // Union: a chain is rebalanceable if it's in deploymentChains AND in at least one route
  const rebalanceableChains = deploymentChains.filter((chain) =>
    routeData.some(({ chainSet }) => chainSet.has(chain)),
  );

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      // For each (currentChain, remoteChain) pair, only include bridges
      // from routes that have both chains
      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => {
            const bridges = routeData
              .filter(
                ({ chainSet }) =>
                  chainSet.has(currentChain) && chainSet.has(remoteChain),
              )
              .map(({ bridgesByChain }) => {
                const bridge = bridgesByChain[currentChain];
                assert(bridge, `No bridge found for chain ${currentChain}`);
                return { bridge };
              });
            return [String(getDomainId(remoteChain)), bridges] as const;
          })
          .filter(([, bridges]) => bridges.length > 0),
      );

      return {
        allowedRebalancers: [REBALANCER],
        allowedRebalancingBridges,
      };
    },
  );
}

/**
 * Returns the set of cross-collateral target routers (as bytes32), keyed by chain,
 * unioned across the given warp routes and deduplicated.
 *
 * Used to key per-destination-token fee contracts in a CrossCollateralRoutingFee:
 * the inner fee map is keyed by the destination router's bytes32 (the target token),
 * matching the on-chain lookup `feeContracts[destination][targetRouter]`.
 */
export function getCrossCollateralTargetRoutersByChain(
  warpRouteIds: readonly WarpRouteIds[],
): ChainMap<string[]> {
  const registry = getRegistry();
  const routersByChain: ChainMap<string[]> = {};

  for (const warpRouteId of warpRouteIds) {
    const route = registry.getWarpRoute(warpRouteId);
    assert(route, `Warp route ${warpRouteId} not found`);

    for (const { chainName, addressOrDenom } of route.tokens) {
      assert(
        addressOrDenom,
        `Missing router address for ${warpRouteId} on ${chainName}`,
      );
      const routerKey = addressToBytes32(addressOrDenom);
      const existing = (routersByChain[chainName] ??= []);
      if (!existing.includes(routerKey)) {
        existing.push(routerKey);
      }
    }
  }

  return routersByChain;
}

export const getRebalancingUSDTConfigForChain = (
  currentChain: keyof typeof usdtTokenAddresses,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: ChainMap<Address>,
  rebalancingConfigByChain: ChainMap<RebalancingConfig>,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  const usdtTokenAddress = usdtTokenAddresses[currentChain];
  assert(
    usdtTokenAddress,
    `USDT token address not found for chain ${currentChain}`,
  );

  const currentRebalancingConfig = rebalancingConfigByChain[currentChain];
  assert(
    currentRebalancingConfig,
    `Rebalancing config not found for chain ${currentChain}`,
  );
  const { allowedRebalancers, allowedRebalancingBridges } =
    currentRebalancingConfig;

  return {
    type: TokenType.collateral,
    token: usdtTokenAddress,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
    allowedRebalancers,
    allowedRebalancingBridges,
  };
};

export const getCollateralTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
  collateralTokensByChain: ChainMap<Address>,
  tokenFee?: TokenFeeConfigInput,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  const collateralAddress = collateralTokensByChain[currentChain];
  assert(
    collateralAddress,
    `Collateral token address not found for chain ${currentChain}`,
  );

  return {
    type: TokenType.collateral,
    token: collateralAddress,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
    tokenFee,
  };
};

export const getSyntheticTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  return {
    type: TokenType.synthetic,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
  };
};

export const getNativeTokenConfigForChain = <
  TOwnerAddress extends ChainMap<Address>,
>(
  currentChain: Extract<keyof TOwnerAddress, ChainName>,
  routerConfigByChain: ChainMap<RouterConfigWithoutOwner>,
  ownersByChain: TOwnerAddress,
): HypTokenRouterConfig => {
  const owner = ownersByChain[currentChain];
  assert(owner, `Owner not found for chain ${currentChain}`);

  return {
    type: TokenType.native,
    mailbox: routerConfigByChain[currentChain].mailbox,
    owner,
  };
};

/**
 * Returns the scale config for a chain based on its local decimals vs message decimals.
 * - Chains at messageDecimals: no scale (1/1)
 * - Chains above (e.g. BSC 18-dec): scale down with {numerator: 1, denominator: 10^diff}
 */
export function scaleDownConfig(
  localDecimals: number,
  messageDecimals: number,
) {
  const diff = localDecimals - messageDecimals;
  assert(
    diff >= 0,
    `Local decimals ${localDecimals} < message decimals ${messageDecimals}`,
  );
  if (diff === 0) return { scale: { numerator: 1, denominator: 1 } };
  return { scale: { numerator: 1, denominator: Math.pow(10, diff) } };
}

/**
 * Creates a RoutingFee configuration with a fixed fee for specified destinations.
 * Destinations not included will have no fee (RoutingFee returns 0 for unconfigured destinations).
 * The fee token is auto-derived at deploy time based on the warp route token type.
 *
 * @param owner - The owner address for the fee contract
 * @param feeDestinations - List of destination chains that should have the fee applied
 * @param bps - The fee in basis points to apply for feeDestinations
 * @param feeParams - Optional pre-deployed fee parameters per chain
 * @param quoteSigners - If provided, uses OffchainQuotedLinearFee instead of LinearFee
 */
export function getFixedRoutingFeeConfig(
  owner: Address,
  feeDestinations: readonly ChainName[],
  bps: number | Record<ChainName, number>,
  feeParams?: Record<string, { maxFee: string; halfAmount: string }>,
  quoteSigners?: Address[],
): TokenFeeConfigInput {
  const feeContracts: Record<ChainName, TokenFeeConfigInput> = {};

  for (const chain of feeDestinations) {
    const chainBps = typeof bps === 'number' ? bps : bps[chain];
    assert(chainBps != null, `Missing bps for destination chain ${chain}`);

    const params = feeParams?.[chain];
    if (quoteSigners) {
      feeContracts[chain] = params
        ? {
            type: TokenFeeType.OffchainQuotedLinearFee,
            owner,
            bps: chainBps,
            maxFee: BigInt(params.maxFee),
            halfAmount: BigInt(params.halfAmount),
            quoteSigners,
          }
        : {
            type: TokenFeeType.OffchainQuotedLinearFee,
            owner,
            bps: chainBps,
            quoteSigners,
          };
    } else {
      feeContracts[chain] = params
        ? {
            type: TokenFeeType.LinearFee,
            owner,
            bps: chainBps,
            maxFee: BigInt(params.maxFee),
            halfAmount: BigInt(params.halfAmount),
          }
        : { type: TokenFeeType.LinearFee, owner, bps: chainBps };
    }
  }

  return {
    type: TokenFeeType.RoutingFee,
    owner,
    feeContracts,
  };
}

/**
 * Creates a file submitter strategy config for the given chains.
 * 'file' submitter type is CLI-specific (not in SDK types), so we use type assertion.
 */
export function getFileSubmitterStrategyConfig(
  chains: readonly string[],
  filepath: string,
): ChainSubmissionStrategy {
  return Object.fromEntries(
    chains.map((chain) => [
      chain,
      { submitter: { type: 'file', filepath, chain } },
    ]),
  ) as unknown as ChainSubmissionStrategy;
}

/**
 * Merges multiple allowedRebalancingBridges maps by concatenating bridge arrays
 * for overlapping domain IDs. Undefined inputs are skipped.
 */
export function mergeAllowedBridges(
  ...configs: (
    | NonNullable<MovableTokenConfig['allowedRebalancingBridges']>
    | undefined
  )[]
): NonNullable<MovableTokenConfig['allowedRebalancingBridges']> {
  const result: NonNullable<MovableTokenConfig['allowedRebalancingBridges']> =
    {};
  for (const config of configs) {
    if (!config) continue;
    for (const [domain, bridges] of Object.entries(config)) {
      result[domain] = [...(result[domain] ?? []), ...bridges];
    }
  }
  return result;
}

/**
 * Creates an impersonated account strategy for anvil forks.
 * 'impersonatedAccount' is CLI-specific (not in SDK types), so we use type assertion.
 */
export function getImpersonatedAccountStrategyConfig(
  chains: readonly string[],
  userAddress: Address,
): ChainSubmissionStrategy {
  return Object.fromEntries(
    chains.map((chain) => [
      chain,
      { submitter: { type: 'impersonatedAccount', userAddress, chain } },
    ]),
  ) as unknown as ChainSubmissionStrategy;
}
