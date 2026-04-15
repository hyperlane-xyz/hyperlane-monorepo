import { expect } from 'chai';
import sinon from 'sinon';

import { CrossCollateralRouter__factory } from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { test1, test2, testSealevelChain } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';
import { getScaleViolations } from './warpCheck.js';

const MAILBOX = '0x000000000000000000000000000000000000b001';
const OWNER = '0x000000000000000000000000000000000000dEaD';
const ROUTER_B = '0x2222222222222222222222222222222222222222';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type ScaleValidationParams = Parameters<typeof getScaleViolations>[0];
type ScaleValidationWarpRouteConfig = ScaleValidationParams['warpRouteConfig'];

function buildMultiProvider(): MultiProvider {
  return new MultiProvider({
    [test1.name]: test1,
    [test2.name]: test2,
    [testSealevelChain.name]: testSealevelChain,
  });
}

function stubConfiguredRouterMetadata({
  decimals,
  scale,
}: {
  decimals: number;
  scale?: Awaited<ReturnType<EvmWarpRouteReader['fetchScale']>>;
}) {
  const connectStub = sinon
    .stub(CrossCollateralRouter__factory, 'connect')
    .returns({
      wrappedToken: async () => TOKEN_B,
      // CAST: unit test only uses wrappedToken()
    } as ReturnType<typeof CrossCollateralRouter__factory.connect>);

  const metadataStub = sinon
    .stub(EvmWarpRouteReader.prototype, 'fetchERC20Metadata')
    .resolves({
      decimals,
      isNft: false,
      name: 'TOKEN',
      symbol: 'TOKEN',
    });

  const scaleStub = sinon
    .stub(EvmWarpRouteReader.prototype, 'fetchScale')
    .resolves(scale);

  return { connectStub, metadataStub, scaleStub };
}

function buildCrossCollateralConfig({
  crossCollateralRouters,
  decimals,
  scale,
}: {
  crossCollateralRouters?: Record<string, string[]>;
  decimals: number;
  scale?: number;
}): ScaleValidationWarpRouteConfig[string] {
  return {
    crossCollateralRouters,
    decimals,
    mailbox: MAILBOX,
    name: 'TOKEN',
    owner: OWNER,
    scale,
    symbol: 'TOKEN',
    token: TOKEN_A,
    type: TokenType.crossCollateral,
  };
}

describe('getScaleViolations', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('passes when an off-subroute configured CCR router shares the same effective scale', async () => {
    const { connectStub, metadataStub, scaleStub } =
      stubConfiguredRouterMetadata({ decimals: 18 });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      [test1.name]: buildCrossCollateralConfig({
        crossCollateralRouters: {
          [test2.domainId.toString()]: [addressToBytes32(ROUTER_B)],
        },
        decimals: 6,
        scale: 1_000_000_000_000,
      }),
    };

    const violations = await getScaleViolations({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(violations).to.deep.equal([]);
    expect(
      connectStub.calledOnceWithExactly(ROUTER_B, sinon.match.object),
    ).to.equal(true);
    expect(metadataStub.calledOnceWithExactly(TOKEN_B)).to.equal(true);
    expect(scaleStub.calledOnceWithExactly(ROUTER_B)).to.equal(true);
  });

  it('fails when an off-subroute configured CCR router has mismatched decimals', async () => {
    stubConfiguredRouterMetadata({ decimals: 8 });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      [test1.name]: buildCrossCollateralConfig({
        crossCollateralRouters: {
          [test2.domainId.toString()]: [addressToBytes32(ROUTER_B)],
        },
        decimals: 6,
        scale: 1_000_000_000_000,
      }),
    };

    const violations = await getScaleViolations({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(violations).to.deep.equal([
      {
        actual: 'invalid-or-missing',
        chain: 'route',
        expected: 'consistent-with-decimals',
        name: 'scale',
        type: 'ScaleMismatch',
      },
    ]);
  });

  it('skips configured CCR routers on non-EVM chains', async () => {
    const connectStub = sinon.stub(CrossCollateralRouter__factory, 'connect');

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      [test1.name]: buildCrossCollateralConfig({
        crossCollateralRouters: {
          [testSealevelChain.domainId.toString()]: [
            'So11111111111111111111111111111111111111112',
          ],
        },
        decimals: 6,
        scale: 1_000_000_000_000,
      }),
    };

    const violations = await getScaleViolations({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(violations).to.deep.equal([]);
    expect(connectStub.notCalled).to.equal(true);
  });
});
