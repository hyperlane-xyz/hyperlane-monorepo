import { expect } from 'chai';
import sinon from 'sinon';

import {
  DEFAULT_ROUTER_KEY,
  TokenStandard,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getUSDCCitreaMoonpayWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDCCitreaMoonpayWarpConfig.js';
import { getUSDTCitreaMoonpayWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayWarpConfig.js';
import { getUSDGRobinhoodMoonpayWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDGRobinhoodMoonpayWarpConfig.js';
import {
  getMoonpayCrossCollateralRouters,
  MOONPAY_DEFAULT_FEE_BPS,
} from '../config/environments/mainnet3/warp/configGetters/moonpay.js';
import { REBALANCER } from '../config/environments/mainnet3/warp/configGetters/utils.js';
import { WARP_FEES_TURNKEY_OWNER } from '../config/environments/mainnet3/governance/utils.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getDomainId, getRegistry } from '../config/registry.js';

const router = '0x1111111111111111111111111111111111111111';
const routerKey = addressToBytes32(router);

function registerUsdg(includeArc = false) {
  const registry = getRegistry();
  const getRoute = registry.getWarpRoute.bind(registry);
  sinon.stub(registry, 'getWarpRoute').callsFake((id) =>
    id === WarpRouteIds.USDGRobinhoodMoonpay
      ? {
          tokens: [
            {
              chainName: 'robinhood',
              addressOrDenom: router,
              collateralAddressOrDenom:
                '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
              standard: TokenStandard.EvmHypCrossCollateralRouter,
              name: 'Global Dollar',
              symbol: 'USDG',
              decimals: 6,
            },
          ],
        }
      : (() => {
          const route = getRoute(id);
          if (id !== WarpRouteIds.USDCCitreaMoonpay || !includeArc)
            return route;
          assert(route, 'Missing USDC Moonpay route');
          return {
            ...route,
            tokens: [
              ...route.tokens.filter((token) => token.chainName !== 'arc'),
              {
                chainName: 'arc',
                addressOrDenom: '0x2222222222222222222222222222222222222222',
                collateralAddressOrDenom:
                  '0x3600000000000000000000000000000000000000',
                standard: TokenStandard.EvmHypCrossCollateralRouter,
                name: 'USD Coin',
                symbol: 'USDC',
                decimals: 6,
              },
            ],
          };
        })(),
  );
}

function getRouterConfig() {
  return Object.fromEntries(
    Object.entries(getRegistry().getAddresses()).map(([chain, addresses]) => {
      assert(addresses.mailbox, `Missing ${chain} mailbox`);
      return [chain, { mailbox: addresses.mailbox }];
    }),
  );
}

function expectQuotedFeesToUseTurnkey(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;

  if ('bps' in value) {
    expect(value).to.have.property('owner', WARP_FEES_TURNKEY_OWNER);
    expect(value).to.have.property('bps', MOONPAY_DEFAULT_FEE_BPS);
  }

  for (const nested of Object.values(value)) {
    expectQuotedFeesToUseTurnkey(nested);
  }
}

describe('Moonpay production rebalancing', () => {
  it('uses the Eclipse USDC route for Arc rebalancing', async () => {
    const registry = getRegistry();
    const eclipseRoute = registry.getWarpRoute(WarpRouteIds.EclipseUSDC);
    assert(eclipseRoute, 'Missing Eclipse USDC route');

    const config = await getUSDCCitreaMoonpayWarpConfig(getRouterConfig());
    const arcRouter = eclipseRoute.tokens.find(
      ({ chainName }) => chainName === 'arc',
    )?.addressOrDenom;
    assert(arcRouter, 'Missing Arc router in Eclipse USDC route');

    for (const chain of ['arbitrum', 'base', 'ethereum', 'polygon']) {
      const localRouter: string | undefined = eclipseRoute.tokens.find(
        ({ chainName }) => chainName === chain,
      )?.addressOrDenom;
      assert(localRouter, `Missing ${chain} router in Eclipse USDC route`);

      expect(config.arc)
        .to.have.nested.property(`allowedRebalancingBridges.${chain}`)
        .that.deep.includes({ bridge: arcRouter });
      expect(config[chain])
        .to.have.nested.property('allowedRebalancingBridges.arc')
        .that.deep.includes({ bridge: localRouter });
    }
  });

  it('uses the Turnkey owner and default fee for every MoonPay fee contract', async () => {
    const routerConfig = getRouterConfig();
    const configs = [
      await getUSDCCitreaMoonpayWarpConfig(routerConfig),
      await getUSDTCitreaMoonpayWarpConfig(routerConfig, {}),
      await getUSDGRobinhoodMoonpayWarpConfig(routerConfig),
    ];

    for (const config of configs) {
      for (const [chain, leg] of Object.entries(config)) {
        if (chain === 'solanamainnet') {
          expect(leg).not.to.have.property('tokenFee');
          continue;
        }

        expect(leg).to.have.nested.property(
          'tokenFee.owner',
          WARP_FEES_TURNKEY_OWNER,
        );
        expectQuotedFeesToUseTurnkey(leg);
      }
    }
  });
});

describe('Moonpay production USDG rollout', () => {
  afterEach(() => sinon.restore());

  it('deploys a disconnected one-leg USDG route before its address is registered', async () => {
    const registry = getRegistry();
    const getRoute = registry.getWarpRoute.bind(registry);
    sinon
      .stub(registry, 'getWarpRoute')
      .callsFake((id) =>
        id === WarpRouteIds.USDGRobinhoodMoonpay ? null : getRoute(id),
      );
    const config = await getUSDGRobinhoodMoonpayWarpConfig(getRouterConfig());
    expect(Object.keys(config)).to.deep.equal(['robinhood']);
    expect(config.robinhood)
      .to.have.property('allowedRebalancers')
      .that.deep.equals([REBALANCER]);
    WarpRouteDeployConfigSchema.parse(config);
    expect(config.robinhood).not.to.have.property('interchainSecurityModule');
    expect(config.robinhood).not.to.have.property('remoteRouters');
    expect(config.robinhood).to.have.nested.property(
      `tokenFee.feeContracts.arc.${DEFAULT_ROUTER_KEY}.bps`,
      MOONPAY_DEFAULT_FEE_BPS,
    );
    expect(config.robinhood)
      .to.have.property('crossCollateralRouters')
      .that.deep.equals({});
    for (const getter of [
      getUSDCCitreaMoonpayWarpConfig,
      getUSDTCitreaMoonpayWarpConfig,
    ]) {
      const sibling = await getter(getRouterConfig(), {});
      expect(sibling).not.to.have.property('robinhood');
      for (const [chain, leg] of Object.entries(sibling)) {
        if (chain === 'solanamainnet') continue;
        expect(leg).to.have.nested.property(
          'interchainSecurityModule.modules.0.domains.robinhood.type',
          'defaultFallbackRoutingIsm',
        );
        expect(leg)
          .to.have.nested.property('tokenFee.feeContracts.robinhood')
          .that.has.all.keys(DEFAULT_ROUTER_KEY);
        expect(leg).to.have.nested.property(
          `tokenFee.feeContracts.robinhood.${DEFAULT_ROUTER_KEY}.bps`,
          MOONPAY_DEFAULT_FEE_BPS,
        );
        expect(leg).to.have.nested.property(
          `tokenFee.feeContracts.arc.${DEFAULT_ROUTER_KEY}.bps`,
          MOONPAY_DEFAULT_FEE_BPS,
        );
        if (chain !== 'arc')
          expect(leg).to.have.nested.property(
            'interchainSecurityModule.modules.0.domains.arc',
          );
      }
      for (const leg of Object.values(sibling)) {
        expect(leg)
          .to.have.property('crossCollateralRouters')
          .that.not.has.property(String(getDomainId('robinhood')));
      }
    }
  });

  it('wires both peers per domain and reciprocal enrollments and fees after registration', async () => {
    registerUsdg(true);
    const config = await getUSDGRobinhoodMoonpayWarpConfig(getRouterConfig());
    WarpRouteDeployConfigSchema.parse(config);
    expect(config.robinhood).not.to.have.property('interchainSecurityModule');
    expect(Object.keys(config)).to.deep.equal(['robinhood']);
    expect(config.robinhood)
      .to.have.property('allowedRebalancers')
      .that.deep.equals([REBALANCER]);
    expect(config.robinhood)
      .to.have.property('crossCollateralRouters')
      .that.deep.equals(
        getMoonpayCrossCollateralRouters(
          [WarpRouteIds.USDCCitreaMoonpay, WarpRouteIds.USDTCitreaMoonpay],
          false,
        ),
      );
    const peers = getMoonpayCrossCollateralRouters(
      [WarpRouteIds.USDCCitreaMoonpay, WarpRouteIds.USDTCitreaMoonpay],
      false,
    );
    expect(peers[String(getDomainId('base'))]).to.have.length(2);
    expect(peers).not.to.have.property(String(getDomainId('robinhood')));
    const arcRouter = addressToBytes32(
      '0x2222222222222222222222222222222222222222',
    );
    expect(peers[String(getDomainId('arc'))]).to.deep.equal([arcRouter]);
    expect(config.robinhood).to.have.nested.property(
      `tokenFee.feeContracts.arc.${arcRouter}.bps`,
      MOONPAY_DEFAULT_FEE_BPS,
    );
    const usdt = await getUSDTCitreaMoonpayWarpConfig(getRouterConfig(), {});
    for (const leg of Object.values(usdt)) {
      expect(leg)
        .to.have.property('crossCollateralRouters')
        .that.has.property(String(getDomainId('arc')))
        .that.deep.equals([arcRouter]);
      expect(leg).to.have.nested.property(
        `tokenFee.feeContracts.arc.${arcRouter}.bps`,
        MOONPAY_DEFAULT_FEE_BPS,
      );
    }
    const fast = getRegistry().getWarpRoute(WarpRouteIds.MainnetCCTPV2Fast);
    assert(fast, 'Missing CCTP fast route');
    for (const chain of ['arbitrum', 'base', 'ethereum', 'polygon']) {
      const fastRouter: string | undefined = fast.tokens.find(
        (candidate) => candidate.chainName === chain,
      )?.addressOrDenom;
      assert(fastRouter, `Missing CCTP fast router on ${chain}`);
      expect(usdt[chain]).to.have.nested.property(
        'interchainSecurityModule.modules.0.domains.arc',
        fastRouter,
      );
      expect(usdt[chain]).to.have.nested.property(
        'hook.domains.arc.hooks.1',
        fastRouter,
      );
    }
    for (const getter of [
      getUSDCCitreaMoonpayWarpConfig,
      getUSDTCitreaMoonpayWarpConfig,
    ]) {
      const sibling = await getter(getRouterConfig(), {});
      WarpRouteDeployConfigSchema.parse(sibling);
      expect(sibling).not.to.have.property('robinhood');
      for (const [chain, leg] of Object.entries(sibling)) {
        if (chain === 'solanamainnet') continue;
        expect(leg).to.have.nested.property(
          'interchainSecurityModule.modules.0.domains.robinhood.type',
          'defaultFallbackRoutingIsm',
        );
      }
      for (const [chain, leg] of Object.entries(sibling)) {
        expect(leg)
          .to.have.property('crossCollateralRouters')
          .that.has.property(String(getDomainId('robinhood')))
          .that.deep.equals([routerKey]);
        if (chain === 'solanamainnet') continue;
        expect(leg).to.have.nested.property(
          `tokenFee.feeContracts.robinhood.${routerKey}`,
        );
      }
    }
  });
});
