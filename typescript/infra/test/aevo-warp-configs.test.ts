import { expect } from 'chai';
import sinon from 'sinon';

import {
  ChainMap,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  MovableTokenConfig,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfigSchema,
  XERC20Type,
  isMovableCollateralTokenConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { DEPLOYER } from '../config/environments/mainnet3/owners.js';
import {
  AEVO_PROD_OWNERS,
  AEVO_STAGING_OWNER,
  AEVO_STAGING_OWNERS,
  AEVO_USDC_LIMITS,
  AevoOwners,
  getAevoMaxCapacity,
  getAevoSecurityConfig,
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

const STAGING_OWNER: Address = '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913';
// The Turnkey pauser, as a literal so that a change in the code under test is caught.
const EXPECTED_PAUSER: Address = '0x60Cc386C85717CB51C2827A75e14826883dF5da4';

// Four different owners, so that taking one chain's owner for another is caught.
// None is the pauser.
const DISTINCT_OWNERS: AevoOwners = {
  aevo: '0x1000000000000000000000000000000000000001',
  optimism: '0x2000000000000000000000000000000000000002',
  arbitrum: '0x3000000000000000000000000000000000000003',
  base: '0x4000000000000000000000000000000000000004',
};
const RATE_LIMIT_DURATION_SECONDS = 86_400n;

interface LimitCase {
  chain: OriginChain | 'aevo';
  hookMaxCapacity: string;
  ismMaxCapacity: string;
}

// Daily caps from the Aevo security proposal, in base units rounded down to a
// multiple of 86400: hook = what the chain lets out, ISM = what it lets in.
const USDC_LIMIT_CASES: LimitCase[] = [
  {
    chain: 'aevo',
    hookMaxCapacity: '124999977600',
    ismMaxCapacity: '99999964800',
  },
  {
    chain: 'optimism',
    hookMaxCapacity: '19999958400',
    ismMaxCapacity: '124999977600',
  },
  {
    chain: 'arbitrum',
    hookMaxCapacity: '74999952000',
    ismMaxCapacity: '124999977600',
  },
  {
    chain: 'base',
    hookMaxCapacity: '19999958400',
    ismMaxCapacity: '124999977600',
  },
];
const WETH_LIMIT_CASES: LimitCase[] = [
  {
    chain: 'aevo',
    hookMaxCapacity: '1499999999999990400',
    ismMaxCapacity: '2999999999999980800',
  },
  {
    chain: 'optimism',
    hookMaxCapacity: '2999999999999980800',
    ismMaxCapacity: '2999999999999980800',
  },
  {
    chain: 'arbitrum',
    hookMaxCapacity: '2999999999999980800',
    ismMaxCapacity: '2999999999999980800',
  },
  {
    chain: 'base',
    hookMaxCapacity: '2999999999999980800',
    ismMaxCapacity: '2999999999999980800',
  },
];

function expectedHook(
  pausableOwner: Address,
  routeOwner: Address,
  maxCapacity: string,
): HookConfig {
  return {
    type: HookType.AGGREGATION,
    hooks: [
      { type: HookType.PAUSABLE, owner: pausableOwner, paused: false },
      {
        type: HookType.RATE_LIMITED,
        owner: routeOwner,
        maxCapacity,
        duration: RATE_LIMIT_DURATION_SECONDS,
      },
      { type: HookType.MAILBOX_DEFAULT },
    ],
  };
}

function expectedIsm(
  pausableOwner: Address,
  routeOwner: Address,
  maxCapacity: string,
): IsmConfig {
  return {
    type: IsmType.AGGREGATION,
    threshold: 3,
    modules: [
      { type: IsmType.PAUSABLE, owner: pausableOwner, paused: false },
      {
        type: IsmType.RATE_LIMITED,
        owner: routeOwner,
        maxCapacity,
        duration: RATE_LIMIT_DURATION_SECONDS,
      },
      { type: IsmType.FALLBACK_ROUTING, owner: routeOwner, domains: {} },
    ],
  };
}

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

function getLeg<T>(config: ChainMap<T>, chain: string): T {
  const leg = config[chain];
  assert(leg, `Missing ${chain} leg`);
  return leg;
}

function getAllowedBridges(leg: HypTokenRouterConfig): AllowedBridges {
  assert(isMovableCollateralTokenConfig(leg), 'Leg is not movable collateral');
  assert(leg.allowedRebalancingBridges, 'Missing allowedRebalancingBridges');
  return leg.allowedRebalancingBridges;
}

function getMaxCapacities(
  leg: Pick<HypTokenRouterConfig, 'hook' | 'interchainSecurityModule'>,
): {
  hook: string;
  ism: string;
} {
  const { hook, interchainSecurityModule: ism } = leg;
  assert(
    typeof hook === 'object' && hook.type === HookType.AGGREGATION,
    'Leg has no aggregation hook',
  );
  assert(
    typeof ism === 'object' && ism.type === IsmType.AGGREGATION,
    'Leg has no aggregation ISM',
  );
  const rateLimitedHook = hook.hooks.find(
    (h) => typeof h === 'object' && h.type === HookType.RATE_LIMITED,
  );
  const rateLimitedIsm = ism.modules.find(
    (m) => typeof m === 'object' && m.type === IsmType.RATE_LIMITED,
  );
  assert(
    typeof rateLimitedHook === 'object' &&
      rateLimitedHook.type === HookType.RATE_LIMITED,
    'Aggregation hook has no rate limited hook',
  );
  assert(
    typeof rateLimitedIsm === 'object' &&
      rateLimitedIsm.type === IsmType.RATE_LIMITED,
    'Aggregation ISM has no rate limited ISM',
  );
  return {
    hook: rateLimitedHook.maxCapacity,
    ism: rateLimitedIsm.maxCapacity,
  };
}

interface RouteCase {
  name: string;
  getConfig: (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ) => Promise<ChainMap<HypTokenRouterConfig>>;
  owners: AevoOwners;
  tokens: Record<OriginChain | 'aevo', Address>;
  limits: LimitCase[];
}

const usdcCases: RouteCase[] = [
  {
    name: 'USDC staging',
    getConfig: getAevoUSDCStagingWarpConfig,
    owners: AEVO_STAGING_OWNERS,
    tokens: USDC_TOKENS,
    limits: USDC_LIMIT_CASES,
  },
  {
    name: 'USDC prod',
    getConfig: getAevoUSDCWarpConfig,
    owners: AEVO_PROD_OWNERS,
    tokens: USDC_TOKENS,
    limits: USDC_LIMIT_CASES,
  },
];

const wethCases: RouteCase[] = [
  {
    name: 'WETH staging',
    getConfig: getAevoWETHStagingWarpConfig,
    owners: AEVO_STAGING_OWNERS,
    tokens: WETH_TOKENS,
    limits: WETH_LIMIT_CASES,
  },
  {
    name: 'WETH prod',
    getConfig: getAevoWETHWarpConfig,
    owners: AEVO_PROD_OWNERS,
    tokens: WETH_TOKENS,
    limits: WETH_LIMIT_CASES,
  },
];

const cases: RouteCase[] = [...usdcCases, ...wethCases];

interface CapacityCase {
  name: string;
  amount: string;
  decimals: number;
  expected: string;
}

const capacityCases: CapacityCase[] = [
  { name: '20K USDC', amount: '20000', decimals: 6, expected: '19999958400' },
  { name: '75K USDC', amount: '75000', decimals: 6, expected: '74999952000' },
  { name: '100K USDC', amount: '100000', decimals: 6, expected: '99999964800' },
  {
    name: '125K USDC',
    amount: '125000',
    decimals: 6,
    expected: '124999977600',
  },
  {
    name: '3 WETH',
    amount: '3',
    decimals: 18,
    expected: '2999999999999980800',
  },
  {
    name: '1.5 WETH (fractional amount)',
    amount: '1.5',
    decimals: 18,
    expected: '1499999999999990400',
  },
  {
    name: 'an amount that is already a multiple of the duration',
    amount: '86400',
    decimals: 0,
    expected: '86400',
  },
  {
    name: 'an amount just above a multiple of the duration',
    amount: '86401',
    decimals: 0,
    expected: '86400',
  },
  {
    name: 'exactly one duration unit',
    amount: '0.0864',
    decimals: 6,
    expected: '86400',
  },
  {
    name: 'digits beyond the token decimals are truncated before rounding (1.2345678)',
    amount: '1.2345678',
    decimals: 6,
    expected: '1209600',
  },
  {
    name: 'digits beyond the token decimals are truncated before rounding (1.0000009)',
    amount: '1.0000009',
    decimals: 6,
    expected: '950400',
  },
];

interface CapacityRejectCase {
  name: string;
  amount: string;
  decimals: number;
}

const capacityRejectCases: CapacityRejectCase[] = [
  { name: 'one base unit below the duration', amount: '0.086399', decimals: 6 },
  { name: 'a tiny amount', amount: '0.00001', decimals: 6 },
];

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

  it('keeps staging owned by the temporary staging owner and prod owned by a non-deployer', () => {
    expect(AEVO_STAGING_OWNER).to.equal(STAGING_OWNER);
    expect(AEVO_STAGING_OWNER).to.not.equal(DEPLOYER);
    expect(AEVO_STAGING_OWNER).to.not.equal(EXPECTED_PAUSER);
    expect(AEVO_STAGING_OWNERS).to.deep.equal({
      aevo: STAGING_OWNER,
      optimism: STAGING_OWNER,
      arbitrum: STAGING_OWNER,
      base: STAGING_OWNER,
    });
    expect(Object.keys(AEVO_PROD_OWNERS)).to.have.members(AEVO_CHAINS);
    for (const owner of Object.values(AEVO_PROD_OWNERS)) {
      expect(owner).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(owner).to.not.equal(DEPLOYER);
      expect(owner).to.not.equal(EXPECTED_PAUSER);
    }
  });

  for (const c of capacityCases) {
    it(`getAevoMaxCapacity: ${c.name}`, () => {
      expect(getAevoMaxCapacity(c.amount, c.decimals)).to.equal(c.expected);
    });
  }

  for (const c of capacityRejectCases) {
    it(`getAevoMaxCapacity: rejects ${c.name}`, () => {
      expect(() => getAevoMaxCapacity(c.amount, c.decimals)).to.throw(
        /below one 86400s duration unit/,
      );
    });
  }

  for (const l of USDC_LIMIT_CASES) {
    it(`getAevoSecurityConfig: owns the ${l.chain} hook and ISM modules with that chain's owner and the pausable ones with the pauser`, () => {
      const security = getAevoSecurityConfig(
        l.chain,
        DISTINCT_OWNERS,
        AEVO_USDC_LIMITS,
      );
      expect(security.hook).to.deep.equal(
        expectedHook(
          EXPECTED_PAUSER,
          DISTINCT_OWNERS[l.chain],
          l.hookMaxCapacity,
        ),
      );
      expect(security.interchainSecurityModule).to.deep.equal(
        expectedIsm(
          EXPECTED_PAUSER,
          DISTINCT_OWNERS[l.chain],
          l.ismMaxCapacity,
        ),
      );
    });
  }

  it('getAevoSecurityConfig: rejects a chain without an owner', () => {
    const owners: AevoOwners = {
      aevo: '',
      optimism: STAGING_OWNER,
      arbitrum: STAGING_OWNER,
      base: STAGING_OWNER,
    };
    expect(() =>
      getAevoSecurityConfig('aevo', owners, AEVO_USDC_LIMITS),
    ).to.throw(/Owner not found for chain aevo/);
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('covers exactly the aevo and origin chains', async () => {
        const config = await c.getConfig(ROUTER_CONFIG);
        expect(Object.keys(config)).to.have.members(AEVO_CHAINS);
      });

      it('configures the aevo leg as HypXERC20 over the existing token with the Aevo router limits', async () => {
        const aevo = getLeg(await c.getConfig(ROUTER_CONFIG), 'aevo');
        const limits = c.limits.find((l) => l.chain === 'aevo');
        assert(limits, 'Missing aevo limit case');
        expect(aevo).to.deep.equal({
          type: TokenType.XERC20,
          token: c.tokens.aevo,
          mailbox: ROUTER_CONFIG.aevo.mailbox,
          owner: c.owners.aevo,
          hook: expectedHook(
            EXPECTED_PAUSER,
            c.owners.aevo,
            limits.hookMaxCapacity,
          ),
          interchainSecurityModule: expectedIsm(
            EXPECTED_PAUSER,
            c.owners.aevo,
            limits.ismMaxCapacity,
          ),
          xERC20: {
            warpRouteLimits: { type: XERC20Type.Aevo, authorized: false },
          },
        });
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
          expect(leg).to.not.have.property('xERC20');
        });
      }

      for (const l of c.limits) {
        it(`configures the ${l.chain} leg hook and ISM with the daily rate limits`, async () => {
          const leg = getLeg(await c.getConfig(ROUTER_CONFIG), l.chain);
          const owner = c.owners[l.chain];
          expect(leg.hook).to.deep.equal(
            expectedHook(EXPECTED_PAUSER, owner, l.hookMaxCapacity),
          );
          expect(leg.interchainSecurityModule).to.deep.equal(
            expectedIsm(EXPECTED_PAUSER, owner, l.ismMaxCapacity),
          );
        });
      }

      it('parses with the warp route deploy config schema', async () => {
        const config = await c.getConfig(ROUTER_CONFIG);
        const parsed = WarpRouteDeployConfigSchema.parse(config);
        expect(Object.keys(parsed)).to.have.members(AEVO_CHAINS);
      });

      it('keeps every maxCapacity unrounded through the deploy config schema', async () => {
        const config = await c.getConfig(ROUTER_CONFIG);
        const parsed = WarpRouteDeployConfigSchema.parse(config);
        for (const l of c.limits) {
          expect(getMaxCapacities(getLeg(parsed, l.chain))).to.deep.equal({
            hook: l.hookMaxCapacity,
            ism: l.ismMaxCapacity,
          });
        }
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
