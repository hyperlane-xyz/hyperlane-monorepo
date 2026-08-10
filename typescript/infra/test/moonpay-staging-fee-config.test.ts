import { expect } from 'chai';

import {
  DEFAULT_ROUTER_KEY,
  TokenFeeConfigInput,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { resetRegistry, setRegistry } from '../config/registry.js';
import { getUSDCCitreaMoonpayStagingWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDCCitreaMoonpayStagingWarpConfig.js';
import { getUSDTCitreaMoonpayStagingWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayStagingWarpConfig.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';

const DEPLOYER = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];
const ARBITRUM_USDC_STAGING_ROUTER =
  '0x9fb176528adf0bb7524ce752b2345c80ed24243f';

const STAGING_UNIVERSE = [
  'solanamainnet',
  'arbitrum',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
] as const;
const USDT_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'katana',
  'polygon',
] as const;
const CCTP_CHAINS = ['arbitrum', 'base', 'ethereum', 'polygon'] as const;
const BRIDGE_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'polygon',
] as const;

const DOMAINS: Record<(typeof STAGING_UNIVERSE)[number], number> = {
  solanamainnet: 1_399_811_149,
  arbitrum: 42_161,
  base: 8_453,
  bsc: 56,
  citrea: 41_114,
  ethereum: 1,
  katana: 747_474,
  polygon: 137,
};

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function tokensFor(
  chains: readonly (typeof STAGING_UNIVERSE)[number][],
  offset: number,
) {
  return chains.map((chainName, index) => ({
    chainName,
    addressOrDenom: address(offset + index),
  }));
}

function installRegistryFixture(): void {
  const usdcStagingTokens = tokensFor(STAGING_UNIVERSE, 100);
  const arbitrumUsdc = usdcStagingTokens.find(
    ({ chainName }) => chainName === 'arbitrum',
  );
  assert(arbitrumUsdc, 'Missing fixture Arbitrum USDC token');
  arbitrumUsdc.addressOrDenom = ARBITRUM_USDC_STAGING_ROUTER;

  const routes: Record<string, { tokens: ReturnType<typeof tokensFor> }> = {
    [WarpRouteIds.USDCCitreaMoonpaySTAGING]: { tokens: usdcStagingTokens },
    [WarpRouteIds.USDTCitreaMoonpaySTAGING]: {
      tokens: tokensFor(USDT_CHAINS, 200),
    },
    [WarpRouteIds.USDTOft]: { tokens: tokensFor(BRIDGE_CHAINS, 300) },
    [WarpRouteIds.EclipseUSDT]: { tokens: tokensFor(BRIDGE_CHAINS, 400) },
    [WarpRouteIds.MainnetCCTPV2Standard]: {
      tokens: tokensFor(CCTP_CHAINS, 500),
    },
    [WarpRouteIds.MainnetCCTPV2Fast]: {
      tokens: tokensFor(CCTP_CHAINS, 600),
    },
    [WarpRouteIds.EclipseUSDC]: {
      tokens: tokensFor(BRIDGE_CHAINS, 700),
    },
    [WarpRouteIds.ParadexUSDC]: {
      tokens: tokensFor(BRIDGE_CHAINS, 800),
    },
    [WarpRouteIds.IgraUSDC]: {
      tokens: tokensFor(BRIDGE_CHAINS, 900),
    },
    [WarpRouteIds.RadixUSDC]: {
      tokens: tokensFor(BRIDGE_CHAINS, 1_000),
    },
    [WarpRouteIds.USDCCitreaIronBridge]: {
      tokens: tokensFor(
        ['arbitrum', 'base', 'ethereum', 'citrea', 'polygon'],
        1_100,
      ),
    },
  };

  setRegistry({
    getWarpRoute: (routeId: string) => routes[routeId],
    getChainMetadata: (chainName: keyof typeof DOMAINS) => ({
      name: chainName,
      protocol:
        chainName === 'solanamainnet'
          ? ProtocolType.Sealevel
          : ProtocolType.Ethereum,
      chainId: DOMAINS[chainName],
      domainId: DOMAINS[chainName],
    }),
  } as unknown as Parameters<typeof setRegistry>[0]);
}

const routerConfig = Object.fromEntries(
  STAGING_UNIVERSE.map((chain, index) => [
    chain,
    { mailbox: address(2_000 + index) },
  ]),
) as Parameters<typeof getUSDTCitreaMoonpayStagingWarpConfig>[0];

describe('Moonpay staging fee topology', () => {
  beforeEach(installRegistryFixture);
  afterEach(resetRegistry);

  it('configures only BSC USDT with defaults and one Arbitrum USDC piecewise override', async () => {
    const config = await getUSDTCitreaMoonpayStagingWarpConfig(routerConfig);
    const originsWithFees = Object.entries(config)
      .filter(([, originConfig]) => originConfig.tokenFee !== undefined)
      .map(([origin]) => origin);
    expect(originsWithFees).to.deep.equal(['bsc']);

    const tokenFee = config.bsc.tokenFee;
    assert(
      tokenFee?.type === TokenFeeType.CrossCollateralRoutingFee,
      'Expected BSC cross-collateral routing fee',
    );
    expect(tokenFee.owner).to.equal(DEPLOYER);
    const feeContracts = tokenFee.feeContracts as Record<
      string,
      Record<string, TokenFeeConfigInput>
    >;
    const destinations = Object.keys(feeContracts);
    expect(destinations).to.have.length(STAGING_UNIVERSE.length);
    expect(destinations).to.have.members([...STAGING_UNIVERSE]);

    for (const destination of STAGING_UNIVERSE) {
      const leaves: Record<string, TokenFeeConfigInput> | undefined =
        feeContracts[destination];
      assert(leaves, `Missing default fee for ${destination}`);
      const fallback = leaves[DEFAULT_ROUTER_KEY];
      assert(
        fallback?.type === TokenFeeType.OffchainQuotedLinearFee,
        `Expected linear default for ${destination}`,
      );
      expect(fallback.owner).to.equal(DEPLOYER);
      expect(fallback.bps).to.equal(3);
      expect(fallback.quoteSigners).to.deep.equal(QUOTE_SIGNERS);
    }

    const explicitLeaves = Object.entries(feeContracts).flatMap(
      ([destination, leaves]) =>
        Object.entries(leaves)
          .filter(([router]) => router !== DEFAULT_ROUTER_KEY)
          .map(([router, fee]) => ({ destination, router, fee })),
    );
    expect(explicitLeaves).to.have.length(1);
    expect(explicitLeaves[0].destination).to.equal('arbitrum');
    expect(explicitLeaves[0].router).to.equal(
      addressToBytes32(ARBITRUM_USDC_STAGING_ROUTER),
    );
    const piecewise = explicitLeaves[0].fee;
    assert(
      piecewise.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee,
      'Expected Arbitrum USDC piecewise fee',
    );
    assert(
      'initialFallback' in piecewise,
      'Expected deployment fallback config',
    );
    expect(piecewise.owner).to.equal(DEPLOYER);
    expect(piecewise.quoteSigners).to.deep.equal(QUOTE_SIGNERS);
    expect(piecewise.maxBands).to.equal(5);
    expect(piecewise.initialFallback).to.deep.equal({
      breakpoints: [250_000_000_000_000_000n, 750_000_000_000_000_000n],
      marginalBps: [4, 10, 20],
    });

    expect(Object.keys(feeContracts.bsc)).to.deep.equal([DEFAULT_ROUTER_KEY]);
  });

  it('keeps every USDC staging origin fee-free', async () => {
    const config = await getUSDCCitreaMoonpayStagingWarpConfig(routerConfig);
    expect(
      Object.values(config).every(({ tokenFee }) => tokenFee === undefined),
    ).to.equal(true);
    expect(config.bsc.tokenFee).to.equal(undefined);
  });
});
