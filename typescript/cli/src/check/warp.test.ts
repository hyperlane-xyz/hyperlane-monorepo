import { expect } from 'chai';
import sinon from 'sinon';

import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { checkCrossCollateralWarpRoute } from './warp.js';

function buildCrossCollateralToken({
  chainName,
  symbol,
  address,
  decimals,
}: {
  chainName: string;
  symbol: string;
  address: string;
  decimals: number;
}) {
  return {
    chainName,
    standard: TokenStandard.EvmHypCrossCollateralRouter,
    decimals,
    symbol,
    name: symbol,
    addressOrDenom: address,
    collateralAddressOrDenom: address,
  };
}

const ROUTER_A = '0x1111111111111111111111111111111111111111';
const ROUTER_B = '0x2222222222222222222222222222222222222222';
const ROUTER_UNRELATED = '0x9999999999999999999999999999999999999999';

const CROSS_CORE_CONFIG: WarpCoreConfig = {
  tokens: [
    buildCrossCollateralToken({
      chainName: 'anvil2',
      symbol: 'USDC',
      address: ROUTER_A,
      decimals: 6,
    }),
    buildCrossCollateralToken({
      chainName: 'anvil3',
      symbol: 'USDT',
      address: ROUTER_B,
      decimals: 6,
    }),
  ],
};

function buildContext(
  allRoutes: Record<string, { coreConfig: WarpCoreConfig; deployConfig: any }>,
) {
  const getWarpRoutes = sinon
    .stub()
    .resolves(
      Object.fromEntries(
        Object.entries(allRoutes).map(([id, r]) => [id, r.coreConfig]),
      ),
    );
  const getWarpDeployConfig = sinon.stub();
  const getChainAddresses = sinon.stub().resolves({ mailbox: ROUTER_A });

  for (const [id, route] of Object.entries(allRoutes)) {
    getWarpDeployConfig.withArgs(id).resolves(route.deployConfig);
  }

  return {
    context: {
      registry: { getWarpRoutes, getWarpDeployConfig, getChainAddresses },
      multiProvider: {
        getDomainId: () => 31337,
        getProtocol: () => 'ethereum',
      },
    } as any,
  };
}

describe('checkCrossCollateralWarpRoute', () => {
  afterEach(() => sinon.restore());

  it('throws when no constituent routes match the CROSS token addresses', async () => {
    const { context } = buildContext({
      'UNRELATED/route': {
        coreConfig: {
          tokens: [
            buildCrossCollateralToken({
              chainName: 'anvil2',
              symbol: 'WETH',
              address: ROUTER_UNRELATED,
              decimals: 18,
            }),
          ],
        },
        deployConfig: { anvil2: {} },
      },
    });

    let thrown: Error | undefined;
    try {
      await checkCrossCollateralWarpRoute({
        context,
        warpCoreConfig: CROSS_CORE_CONFIG,
        warpRouteId: 'CROSS/test',
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown?.message).to.include(
      'no constituent routes could be identified',
    );
  });

  it('surfaces an error when a matched constituent has no deploy config', async () => {
    const { context } = buildContext({
      'USDC/test': {
        coreConfig: {
          tokens: [
            buildCrossCollateralToken({
              chainName: 'anvil2',
              symbol: 'USDC',
              address: ROUTER_A,
              decimals: 6,
            }),
          ],
        },
        deployConfig: null, // missing
      },
    });

    let thrown: Error | undefined;
    try {
      await checkCrossCollateralWarpRoute({
        context,
        warpCoreConfig: CROSS_CORE_CONFIG,
        warpRouteId: 'CROSS/test',
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).to.exist;
    expect(thrown?.message).to.include('No warp route deploy config found');
  });

  it('excludes non-CrossCollateralRouter routes even if their addresses overlap', async () => {
    const { context } = buildContext({
      'USDC/test': {
        coreConfig: {
          tokens: [
            {
              chainName: 'anvil2',
              standard: TokenStandard.EvmHypCollateral, // not a CrossCollateral standard
              decimals: 6,
              symbol: 'USDC',
              name: 'USDC',
              addressOrDenom: ROUTER_A,
              collateralAddressOrDenom: ROUTER_A,
            },
          ],
        },
        deployConfig: { anvil2: {} },
      },
    });

    let thrown: Error | undefined;
    try {
      await checkCrossCollateralWarpRoute({
        context,
        warpCoreConfig: CROSS_CORE_CONFIG,
        warpRouteId: 'CROSS/test',
      });
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown?.message).to.include(
      'no constituent routes could be identified',
    );
  });
});
