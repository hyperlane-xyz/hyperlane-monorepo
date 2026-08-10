import {
  ChainMap,
  CrossCollateralTokenConfig,
  HypTokenRouterConfig,
  MovableTokenConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { DEPLOYER } from '../../owners.js';
import { WarpRouteIds } from '../warpIds.js';
import { getRebalancingBridgesConfigFor } from './utils.js';

// Staging mimic of the production CROSS/moonpay USDT route (getUSDTCitreaMoonpayWarpConfig).
// Same simplifications as the USDC staging getter: deployer-owned, default ISM, default hook,
// zero fee. 6 EVM chains (no Solana XO leg, no Citrea ctUSD leg — those live
// on the USDC route, same as prod).
// Rebalancing IS reproduced from prod: same allowedRebalancers (MCR signer) and the same
// OFT + Eclipse USDT bridge wiring (arbitrum/bsc/ethereum/polygon; base + katana have none).
// EXTRA_REBALANCER is additionally permitted on every leg for staging.

// Owned by the shared Hyperlane deployer key (owners.ts DEPLOYER).
const DEPLOYER_EVM = DEPLOYER;

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';
const EXTRA_REBALANCER = '0x2cB236403574301029c7bDDfda133c6e0338a857';
const ALLOWED_REBALANCERS = [REBALANCER, EXTRA_REBALANCER];
const CONTRACT_VERSION = '12.0.0';

const EVM_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;
const LOCAL_REBALANCE_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'polygon',
] as const;

type RebalancingConfig = Required<
  Pick<MovableTokenConfig, 'allowedRebalancingBridges' | 'allowedRebalancers'>
>;

type AtomicLocalRebalancingConfig = RebalancingConfig &
  Required<
    Pick<CrossCollateralTokenConfig, 'rebalanceRecipients' | 'rebalanceTargets'>
  >;

// Cross-collateral peers reference the sibling USDC staging route by deployed address.
// Returns {} until that route is registered; wire on a second pass via `warp apply`.
function getSiblingCrossCollateralRouters(): Record<string, string[]> {
  const route = getRegistry().getWarpRoute(
    WarpRouteIds.USDCCitreaMoonpaySTAGING,
  );
  if (!route) return {};
  return Object.fromEntries(
    route.tokens.map(({ chainName, addressOrDenom }) => {
      assert(addressOrDenom, `Missing USDC staging router for ${chainName}`);
      return [
        String(getDomainId(chainName)),
        [addressToBytes32(addressOrDenom)],
      ];
    }),
  );
}

// The ALRB route is deployed before it is added to the registry. Until its
// output config is available, preserve the existing staging configuration so
// the bridge deployment getter can be used independently. A second `warp apply`
// pass against the registry branch adds the local bridge wiring.
function getAtomicLocalRebalancingConfig(
  existingByChain: ChainMap<RebalancingConfig>,
): ChainMap<AtomicLocalRebalancingConfig> {
  const registry = getRegistry();
  const bridgeRoute = registry.getWarpRoute(
    WarpRouteIds.CROSSMoonpayStagingLocalBridgeUSDT,
  );
  if (!bridgeRoute) return {};

  const usdcRoute = registry.getWarpRoute(
    WarpRouteIds.USDCCitreaMoonpaySTAGING,
  );
  assert(usdcRoute, 'USDC/moonpay-staging route not found in registry');

  return Object.fromEntries(
    LOCAL_REBALANCE_CHAINS.map((chain) => {
      const bridge = bridgeRoute.tokens.find(
        ({ chainName }) => chainName === chain,
      )?.addressOrDenom;
      assert(bridge, `Missing staging ALRB on ${chain}`);

      const destinationRouter = usdcRoute.tokens.find(
        ({ chainName }) => chainName === chain,
      )?.addressOrDenom;
      assert(destinationRouter, `Missing staging USDC router on ${chain}`);
      const destination = addressToBytes32(destinationRouter);
      const existing = existingByChain[chain] ?? {
        allowedRebalancers: [],
        allowedRebalancingBridges: {},
      };

      return [
        chain,
        {
          allowedRebalancers: [
            ...new Set([
              ...ALLOWED_REBALANCERS,
              ...existing.allowedRebalancers,
              bridge,
            ]),
          ],
          allowedRebalancingBridges: {
            ...existing.allowedRebalancingBridges,
            [chain]: [
              ...(existing.allowedRebalancingBridges[chain] ?? []),
              { bridge },
            ],
          },
          rebalanceTargets: { [chain]: [destination] },
          rebalanceRecipients: { [chain]: destination },
        },
      ];
    }),
  );
}

export async function getUSDTCitreaMoonpayStagingWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const crossCollateralRouters = getSiblingCrossCollateralRouters();

  const oftRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    [...EVM_CHAINS, 'bsc'],
    [WarpRouteIds.USDTOft, WarpRouteIds.EclipseUSDT],
  );
  const atomicLocalRebalancingConfigByChain = getAtomicLocalRebalancingConfig(
    oftRebalancingConfigByChain,
  );
  const rebalancingConfigByChain: ChainMap<RebalancingConfig> =
    Object.fromEntries(
      LOCAL_REBALANCE_CHAINS.map((chain) => [
        chain,
        atomicLocalRebalancingConfigByChain[chain] ?? {
          allowedRebalancers: ALLOWED_REBALANCERS,
          allowedRebalancingBridges:
            oftRebalancingConfigByChain[chain]?.allowedRebalancingBridges ?? {},
        },
      ]),
    );

  assert(oftRebalancingConfigByChain.bsc, 'missing rebalancing config for bsc');

  return {
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDT,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: DEPLOYER_EVM,
      contractVersion: CONTRACT_VERSION,
      ...rebalancingConfigByChain.arbitrum,
      crossCollateralRouters,
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDT,
      mailbox: routerConfig.base.mailbox,
      owner: DEPLOYER_EVM,
      contractVersion: CONTRACT_VERSION,
      ...rebalancingConfigByChain.base,
      crossCollateralRouters,
    },
    bsc: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDT,
      mailbox: routerConfig.bsc.mailbox,
      owner: DEPLOYER_EVM,
      contractVersion: CONTRACT_VERSION,
      ...rebalancingConfigByChain.bsc,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
      crossCollateralRouters,
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: DEPLOYER_EVM,
      contractVersion: CONTRACT_VERSION,
      ...rebalancingConfigByChain.ethereum,
      crossCollateralRouters,
    },
    katana: {
      type: TokenType.crossCollateral,
      token: tokens.katana.USDT,
      mailbox: routerConfig.katana.mailbox,
      owner: DEPLOYER_EVM,
      allowedRebalancers: [EXTRA_REBALANCER],
      crossCollateralRouters,
    },
    polygon: {
      type: TokenType.crossCollateral,
      token: tokens.polygon.USDT,
      mailbox: routerConfig.polygon.mailbox,
      owner: DEPLOYER_EVM,
      contractVersion: CONTRACT_VERSION,
      ...rebalancingConfigByChain.polygon,
      crossCollateralRouters,
    },
  };
}
