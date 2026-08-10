import { expect } from 'chai';

import {
  ChainMap,
  DEFAULT_ROUTER_KEY,
  HypTokenRouterConfig,
  TokenFeeConfigInput,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { warpFeesIcas } from '../config/environments/mainnet3/governance/ica/warpFees.js';
import { getUSDTCitreaMoonpayWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayWarpConfig.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getRegistry } from '../config/registry.js';
import { RouterConfigWithoutOwner } from '../src/config/warp.js';

const BSC_ORIGIN_CHAINS = [
  'arbitrum',
  'base',
  'bsc',
  'ethereum',
  'katana',
  'polygon',
] as const;

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'base',
  'bsc',
  'citrea',
  'ethereum',
  'katana',
  'polygon',
] as const;

const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const EXPECTED_REMOTE_USDC_TARGETS = {
  arbitrum: '0xeBC079D41C41a0ef7e54aa7Af867df9a621C9bE0',
  base: '0x253821543C24623ecD3ceBCEd704359AF16CF38f',
  citrea: '0x2bef59e84615371304bd731601f6344F5F304504',
  ethereum: '0xA9C9a8FB36Ce3e5ffBAC3757dA7141262723541F',
  katana: '0x936e8A1fBD8317Be59A9B8924a300993c8Bf7ce6',
  polygon: '0x28a96f9928dB06317356caACd5641C4Fde4424C7',
  solanamainnet: 'HW9NfLGo6YMoM6o5auTvn5h26tWJPpsroUDfGFwvsQsU',
} as const;

const DUMMY_MAILBOX = '0x0000000000000000000000000000000000000001';

function getRoutingFee(config: ChainMap<HypTokenRouterConfig>, origin: string) {
  const tokenFee = config[origin]?.tokenFee;
  assert(
    tokenFee?.type === TokenFeeType.CrossCollateralRoutingFee,
    `Expected CrossCollateralRoutingFee on ${origin}`,
  );
  return tokenFee;
}

function expectThreeBpsLinear(config: TokenFeeConfigInput | undefined) {
  assert(config, 'Expected fee config');
  expect(config.type).to.equal(TokenFeeType.OffchainQuotedLinearFee);
  if (config.type !== TokenFeeType.OffchainQuotedLinearFee) return;
  expect(config.bps).to.equal(3);
  expect(config.owner).to.equal(warpFeesIcas.bsc);
  expect(config.quoteSigners).to.deep.equal(QUOTE_SIGNERS);
}

describe('USDT/moonpay BSC production piecewise fee topology', () => {
  let config: ChainMap<HypTokenRouterConfig>;

  before(async () => {
    const routerConfig = Object.fromEntries(
      BSC_ORIGIN_CHAINS.map((chain) => [chain, { mailbox: DUMMY_MAILBOX }]),
    ) as ChainMap<RouterConfigWithoutOwner>;

    config = await getUSDTCitreaMoonpayWarpConfig(routerConfig, {});
  });

  it('plans exactly seven distinct piecewise leaves at the registry targets', () => {
    const usdcRoute = getRegistry().getWarpRoute(
      WarpRouteIds.USDCCitreaMoonpay,
    );
    assert(usdcRoute, 'USDC/moonpay route not found in registry');

    const routingFee = getRoutingFee(config, 'bsc');
    const piecewiseEntries: Array<{
      destination: string;
      routerKey: string;
      config: TokenFeeConfigInput;
    }> = [];

    for (const [destination, routerFees] of Object.entries(
      routingFee.feeContracts,
    )) {
      for (const [routerKey, feeConfig] of Object.entries(routerFees)) {
        if (feeConfig.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee) {
          piecewiseEntries.push({ destination, routerKey, config: feeConfig });
        }
      }
    }

    expect(piecewiseEntries).to.have.length(7);
    expect(
      new Set(piecewiseEntries.map(({ config: entry }) => entry)).size,
    ).to.equal(7);

    for (const [destination, expectedAddress] of Object.entries(
      EXPECTED_REMOTE_USDC_TARGETS,
    )) {
      const registryToken = usdcRoute.tokens.find(
        ({ chainName }) => chainName === destination,
      );
      expect(registryToken?.addressOrDenom).to.equal(expectedAddress);

      const expectedRouterKey = addressToBytes32(expectedAddress);
      const entry = piecewiseEntries.find(
        (candidate) =>
          candidate.destination === destination &&
          candidate.routerKey === expectedRouterKey,
      );
      assert(entry, `Missing piecewise leaf for ${destination}`);
      assert(
        entry.config.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee,
        `Expected piecewise leaf for ${destination}`,
      );
      expect(entry.config.owner).to.equal(warpFeesIcas.bsc);
      expect(entry.config.maxBands).to.equal(5);
      assert(
        'initialFallback' in entry.config,
        `Expected initial fallback for ${destination}`,
      );
      expect(entry.config.initialFallback).to.deep.equal({
        breakpoints: [],
        marginalBps: [15],
      });
      expect(entry.config.quoteSigners).to.deep.equal(QUOTE_SIGNERS);
    }
  });

  it('keeps defaults, USDT targets, and same-domain BSC USDC linear', () => {
    const routingFee = getRoutingFee(config, 'bsc');

    for (const destination of ROUTE_CHAINS) {
      expectThreeBpsLinear(
        routingFee.feeContracts[destination]?.[DEFAULT_ROUTER_KEY],
      );
    }

    const usdtRoute = getRegistry().getWarpRoute(
      WarpRouteIds.USDTCitreaMoonpay,
    );
    assert(usdtRoute, 'USDT/moonpay route not found in registry');
    for (const token of usdtRoute.tokens) {
      assert(
        token.addressOrDenom,
        `Missing USDT router for ${token.chainName}`,
      );
      expectThreeBpsLinear(
        routingFee.feeContracts[token.chainName]?.[
          addressToBytes32(token.addressOrDenom)
        ],
      );
    }

    const bscUsdcAddress = getRegistry()
      .getWarpRoute(WarpRouteIds.USDCCitreaMoonpay)
      ?.tokens.find(({ chainName }) => chainName === 'bsc')?.addressOrDenom;
    assert(bscUsdcAddress, 'Missing BSC USDC router');
    expectThreeBpsLinear(
      routingFee.feeContracts.bsc?.[addressToBytes32(bscUsdcAddress)],
    );
  });

  it('does not introduce piecewise leaves on any other origin', () => {
    for (const origin of BSC_ORIGIN_CHAINS.filter((chain) => chain !== 'bsc')) {
      const routingFee = getRoutingFee(config, origin);
      for (const routerFees of Object.values(routingFee.feeContracts)) {
        for (const feeConfig of Object.values(routerFees)) {
          expect(feeConfig.type).to.equal(TokenFeeType.OffchainQuotedLinearFee);
          if (feeConfig.type === TokenFeeType.OffchainQuotedLinearFee) {
            expect(feeConfig.bps).to.equal(3);
          }
        }
      }
    }
  });
});
