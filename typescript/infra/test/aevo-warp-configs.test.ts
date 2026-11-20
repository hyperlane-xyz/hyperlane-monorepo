import { expect } from 'chai';
import sinon from 'sinon';

import {
  ChainMap,
  HypTokenRouterConfig,
  MovableTokenConfig,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfigSchema,
  isMovableCollateralTokenConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { DEPLOYER } from '../config/environments/mainnet3/owners.js';
import {
  AEVO_PROD_OWNERS,
  AEVO_STAGING_OWNERS,
  AevoOwners,
} from '../config/environments/mainnet3/warp/configGetters/aevo.js';
import {
  getAevoUSDCStagingWarpConfig,
  getAevoUSDCWarpConfig,
} from '../config/environments/mainnet3/warp/configGetters/getAevoUSDCWarpConfig.js';
import {
  getAevoWETHStagingWarpConfig,
  getAevoWETHWarpConfig,
} from '../config/environments/mainnet3/warp/configGetters/getAevoWETHWarpConfig.js';
import { REBALANCER } from '../config/environments/mainnet3/warp/configGetters/utils.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getRegistry } from '../config/registry.js';
import { RouterConfigWithoutOwner } from '../src/config/warp.js';

const AEVO_CHAINS = ['aevo', 'optimism', 'arbitrum', 'base'];
const ORIGIN_CHAINS = ['optimism', 'arbitrum', 'base'] as const;

type OriginChain = (typeof ORIGIN_CHAINS)[number];
type AllowedBridges = NonNullable<
  MovableTokenConfig['allowedRebalancingBridges']
>;

const ROUTER_CONFIG: ChainMap<RouterConfigWithoutOwner> = {
  aevo: { mailbox: '0x1111111111111111111111111111111111111111' },
  optimism: { mailbox: '0x2222222222222222222222222222222222222222' },
  arbitrum: { mailbox: '0x3333333333333333333333333333333333333333' },
  base: { mailbox: '0x4444444444444444444444444444444444444444' },
};

// `ethereum` is in the CCTP fixtures but not an Aevo chain, so it must be filtered out.
const CCTP_STANDARD_BRIDGES: Record<OriginChain | 'ethereum', Address> = {
  ethereum: '0x7777777777777777777777777777777777777777',
  optimism: '0x8888888888888888888888888888888888888888',
  arbitrum: '0x9999999999999999999999999999999999999999',
  base: '0x1212121212121212121212121212121212121212',
};
const CCTP_FAST_BRIDGES: Record<OriginChain | 'ethereum', Address> = {
  ethereum: '0x2121212121212121212121212121212121212121',
  optimism: '0x3131313131313131313131313131313131313131',
  arbitrum: '0x5555555555555555555555555555555555555555',
  base: '0x6666666666666666666666666666666666666666',
};

const USDC_TOKENS: Record<OriginChain | 'aevo', Address> = {
  aevo: '0xC06Ed0eB5c0e25fa71B37A3F33CFa62C7d9dD542',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};
const WETH_TOKENS: Record<OriginChain | 'aevo', Address> = {
  aevo: '0xEB5eAb7315f6721d90ED8DD007F802ecbFb99cE8',
  optimism: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  base: '0x4200000000000000000000000000000000000006',
};

// Each origin leg allows both prod CCTP v2 bridges (local address) towards the other origins only.
const USDC_EXPECTED_BRIDGES: Record<OriginChain, AllowedBridges> = {
  optimism: {
    arbitrum: [
      { bridge: CCTP_STANDARD_BRIDGES.optimism },
      { bridge: CCTP_FAST_BRIDGES.optimism },
    ],
    base: [
      { bridge: CCTP_STANDARD_BRIDGES.optimism },
      { bridge: CCTP_FAST_BRIDGES.optimism },
    ],
  },
  arbitrum: {
    optimism: [
      { bridge: CCTP_STANDARD_BRIDGES.arbitrum },
      { bridge: CCTP_FAST_BRIDGES.arbitrum },
    ],
    base: [
      { bridge: CCTP_STANDARD_BRIDGES.arbitrum },
      { bridge: CCTP_FAST_BRIDGES.arbitrum },
    ],
  },
  base: {
    optimism: [
      { bridge: CCTP_STANDARD_BRIDGES.base },
      { bridge: CCTP_FAST_BRIDGES.base },
    ],
    arbitrum: [
      { bridge: CCTP_STANDARD_BRIDGES.base },
      { bridge: CCTP_FAST_BRIDGES.base },
    ],
  },
};

function cctpRoute(bridges: Record<string, Address>): WarpCoreConfig {
  return {
    tokens: Object.entries(bridges).map(([chainName, addressOrDenom]) => ({
      chainName,
      addressOrDenom,
      standard: TokenStandard.EvmHypCollateral,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
    })),
  };
}

function getLeg(
  config: ChainMap<HypTokenRouterConfig>,
  chain: string,
): HypTokenRouterConfig {
  const leg = config[chain];
  assert(leg, `Missing ${chain} leg`);
  return leg;
}

function getAllowedBridges(leg: HypTokenRouterConfig): AllowedBridges {
  assert(isMovableCollateralTokenConfig(leg), 'Leg is not movable collateral');
  assert(leg.allowedRebalancingBridges, 'Missing allowedRebalancingBridges');
  return leg.allowedRebalancingBridges;
}

interface RouteCase {
  name: string;
  getConfig: (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ) => Promise<ChainMap<HypTokenRouterConfig>>;
  owners: AevoOwners;
  tokens: Record<OriginChain | 'aevo', Address>;
}

const usdcCases: RouteCase[] = [
  {
    name: 'USDC staging',
    getConfig: getAevoUSDCStagingWarpConfig,
    owners: AEVO_STAGING_OWNERS,
    tokens: USDC_TOKENS,
  },
  {
    name: 'USDC prod',
    getConfig: getAevoUSDCWarpConfig,
    owners: AEVO_PROD_OWNERS,
    tokens: USDC_TOKENS,
  },
];

const wethCases: RouteCase[] = [
  {
    name: 'WETH staging',
    getConfig: getAevoWETHStagingWarpConfig,
    owners: AEVO_STAGING_OWNERS,
    tokens: WETH_TOKENS,
  },
  {
    name: 'WETH prod',
    getConfig: getAevoWETHWarpConfig,
    owners: AEVO_PROD_OWNERS,
    tokens: WETH_TOKENS,
  },
];

const cases: RouteCase[] = [...usdcCases, ...wethCases];

describe('Aevo warp config getters', () => {
  beforeEach(() => {
    const cctpRoutes: Record<string, WarpCoreConfig> = {
      [WarpRouteIds.MainnetCCTPV2Standard]: cctpRoute(CCTP_STANDARD_BRIDGES),
      [WarpRouteIds.MainnetCCTPV2Fast]: cctpRoute(CCTP_FAST_BRIDGES),
    };
    sinon.stub(getRegistry(), 'getWarpRoute').callsFake((id) => {
      const route = cctpRoutes[id];
      assert(route, `Unexpected registry lookup for warp route ${id}`);
      return route;
    });
  });

  afterEach(() => sinon.restore());

  it('keeps staging owned by the deployer and prod owned by a non-deployer', () => {
    expect(AEVO_STAGING_OWNERS).to.deep.equal({
      aevo: DEPLOYER,
      optimism: DEPLOYER,
      arbitrum: DEPLOYER,
      base: DEPLOYER,
    });
    expect(Object.keys(AEVO_PROD_OWNERS)).to.have.members(AEVO_CHAINS);
    for (const owner of Object.values(AEVO_PROD_OWNERS)) {
      expect(owner).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(owner).to.not.equal(DEPLOYER);
    }
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('covers exactly the aevo and origin chains', async () => {
        const config = await c.getConfig(ROUTER_CONFIG);
        expect(Object.keys(config)).to.have.members(AEVO_CHAINS);
      });

      it('configures the aevo leg as a plain HypXERC20 with mailbox defaults', async () => {
        const aevo = getLeg(await c.getConfig(ROUTER_CONFIG), 'aevo');
        expect(aevo).to.deep.equal({
          type: TokenType.XERC20,
          token: c.tokens.aevo,
          mailbox: ROUTER_CONFIG.aevo.mailbox,
          owner: c.owners.aevo,
        });
        expect(aevo).to.not.have.property('xERC20');
        expect(aevo).to.not.have.property('allowedRebalancers');
        expect(aevo).to.not.have.property('allowedRebalancingBridges');
      });

      for (const chain of ORIGIN_CHAINS) {
        it(`configures the ${chain} leg as collateral over the native token`, async () => {
          const leg = getLeg(await c.getConfig(ROUTER_CONFIG), chain);
          expect(leg).to.deep.include({
            type: TokenType.collateral,
            token: c.tokens[chain],
            mailbox: ROUTER_CONFIG[chain].mailbox,
            owner: c.owners[chain],
          });
          expect(leg).to.not.have.property('hook');
          expect(leg).to.not.have.property('interchainSecurityModule');
        });
      }

      it('parses with the warp route deploy config schema', async () => {
        const config = await c.getConfig(ROUTER_CONFIG);
        const parsed = WarpRouteDeployConfigSchema.parse(config);
        expect(Object.keys(parsed)).to.have.members(AEVO_CHAINS);
      });
    });
  }

  for (const c of usdcCases) {
    for (const chain of ORIGIN_CHAINS) {
      it(`${c.name}: wires CCTP v2 rebalancing on the ${chain} leg`, async () => {
        const leg = getLeg(await c.getConfig(ROUTER_CONFIG), chain);
        expect(leg)
          .to.have.property('allowedRebalancers')
          .that.deep.equals([REBALANCER]);
        expect(getAllowedBridges(leg)).to.deep.equal(
          USDC_EXPECTED_BRIDGES[chain],
        );
      });
    }
  }

  for (const c of wethCases) {
    for (const chain of ORIGIN_CHAINS) {
      it(`${c.name}: sets no on-chain rebalancing on the ${chain} leg`, async () => {
        const leg = getLeg(await c.getConfig(ROUTER_CONFIG), chain);
        expect(leg).to.not.have.property('allowedRebalancers');
        expect(leg).to.not.have.property('allowedRebalancingBridges');
      });
    }
  }
});
