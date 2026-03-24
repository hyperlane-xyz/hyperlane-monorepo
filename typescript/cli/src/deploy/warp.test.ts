// SPDX-License-Identifier: BUSL-1.1
import { expect } from 'chai';
import sinon from 'sinon';

import {
  ProtocolType,
  addressToBytes32,
  rootLogger,
} from '@hyperlane-xyz/utils';
import {
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';

import { runWarpRouteCombine } from './warp.js';

const DOMAIN_BY_CHAIN: Record<string, number> = {
  anvil2: 31337,
  anvil3: 31338,
  anvil4: 31339,
};

function buildCrossCollateralToken({
  chainName,
  symbol,
  address,
  decimals,
  scale,
}: {
  chainName: string;
  symbol: string;
  address: string;
  decimals: number;
  scale?: number | { numerator: number; denominator: number };
}) {
  return {
    chainName,
    standard: TokenStandard.EvmHypCrossCollateralRouter,
    decimals,
    symbol,
    name: symbol,
    addressOrDenom: address,
    collateralAddressOrDenom: address,
    ...(scale ? { scale } : {}),
  };
}

function buildContext(
  routes: Record<string, { coreConfig: WarpCoreConfig; deployConfig: any }>,
) {
  const getWarpRoute = sinon.stub();
  const getWarpDeployConfig = sinon.stub();

  for (const [id, route] of Object.entries(routes)) {
    getWarpRoute.withArgs(id).resolves(route.coreConfig);
    getWarpDeployConfig.withArgs(id).resolves(route.deployConfig);
  }

  const addWarpRouteConfig = sinon.stub().resolves();
  const addWarpRoute = sinon.stub().resolves();

  return {
    context: {
      registry: {
        getWarpRoute,
        getWarpDeployConfig,
        addWarpRouteConfig,
        addWarpRoute,
      },
      multiProvider: {
        getDomainId(chain: string) {
          return DOMAIN_BY_CHAIN[chain];
        },
        getProtocol() {
          return ProtocolType.Ethereum;
        },
      },
    } as any,
    addWarpRouteConfig,
    addWarpRoute,
  };
}

describe('runWarpRouteCombine', () => {
  const ROUTER_A = '0x1111111111111111111111111111111111111111';
  const ROUTER_B = '0x2222222222222222222222222222222222222222';
  const ROUTER_C = '0x3333333333333333333333333333333333333333';

  afterEach(() => {
    sinon.restore();
  });

  it('warns when combine will remove previously enrolled routers', async () => {
    const routeA = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDC',
            address: ROUTER_A,
            decimals: 18,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil2: {
          type: TokenType.crossCollateral,
          owner: ROUTER_A,
          token: ROUTER_A,
          crossCollateralRouters: {
            [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_C)],
          },
        },
      },
    };
    const routeB = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil3',
            symbol: 'USDT',
            address: ROUTER_B,
            decimals: 18,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil3: {
          type: TokenType.crossCollateral,
          owner: ROUTER_B,
          token: ROUTER_B,
        },
      },
    };

    const { context, addWarpRouteConfig } = buildContext({
      'route-a': routeA,
      'route-b': routeB,
    });
    const warnSpy = sinon.spy(rootLogger, 'warn');

    await runWarpRouteCombine({
      context,
      routeIds: ['route-a', 'route-b'],
      outputWarpRouteId: 'MULTI/test',
    });

    expect(warnSpy.called).to.equal(true);
    const warnings = warnSpy.getCalls().map((call) => String(call.args[0]));
    expect(
      warnings.some(
        (warning) =>
          warning.includes('route-a') &&
          warning.includes('will remove 1 enrolled router'),
      ),
    ).to.equal(true);

    const updatedRouteAConfig = addWarpRouteConfig.getCall(0).args[0];
    expect(updatedRouteAConfig.anvil2.crossCollateralRouters).to.deep.equal({
      [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_B)],
    });
  });

  it('rejects duplicate route IDs', async () => {
    let thrown: Error | undefined;
    try {
      await runWarpRouteCombine({
        context: {} as any,
        routeIds: ['route-a', 'route-a'],
        outputWarpRouteId: 'MULTI/test',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include('Duplicate route IDs are not allowed');
  });

  it('rejects empty route IDs', async () => {
    let thrown: Error | undefined;
    try {
      await runWarpRouteCombine({
        context: {} as any,
        routeIds: ['route-a', ''],
        outputWarpRouteId: 'MULTI/test',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include('Route IDs must be non-empty strings');
  });

  it('rejects routes that are not CrossCollateralRouter', async () => {
    const routeA = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDC',
            address: ROUTER_A,
            decimals: 18,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil2: {
          type: TokenType.crossCollateral,
          owner: ROUTER_A,
          token: ROUTER_A,
        },
      },
    };
    const routeB = {
      coreConfig: {
        tokens: [
          {
            chainName: 'anvil3',
            standard: TokenStandard.EvmHypCollateral,
            decimals: 18,
            symbol: 'USDT',
            name: 'USDT',
            addressOrDenom: ROUTER_B,
            collateralAddressOrDenom: ROUTER_B,
          },
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil3: {
          type: TokenType.collateral,
          owner: ROUTER_B,
          token: ROUTER_B,
        },
      },
    };

    const { context } = buildContext({
      'route-a': routeA,
      'route-b': routeB,
    });

    let thrown: Error | undefined;
    try {
      await runWarpRouteCombine({
        context,
        routeIds: ['route-a', 'route-b'],
        outputWarpRouteId: 'MULTI/test',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include(
      'contains non-CrossCollateralRouter deploy configs',
    );
  });

  it('rejects routes with incompatible decimals/scale on the same chain', async () => {
    const routeA = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDC',
            address: ROUTER_A,
            decimals: 6,
            scale: 1_000_000_000_000,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil2: {
          type: TokenType.crossCollateral,
          owner: ROUTER_A,
          token: ROUTER_A,
          scale: 1_000_000_000_000,
        },
      },
    };
    const routeB = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDT',
            address: ROUTER_B,
            decimals: 18,
            scale: 2,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil2: {
          type: TokenType.crossCollateral,
          owner: ROUTER_B,
          token: ROUTER_B,
          scale: 2,
        },
      },
    };

    const { context } = buildContext({
      'route-a': routeA,
      'route-b': routeB,
    });

    let thrown: Error | undefined;
    try {
      await runWarpRouteCombine({
        context,
        routeIds: ['route-a', 'route-b'],
        outputWarpRouteId: 'MULTI/test',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include(
      'Incompatible decimals/scale on chain "anvil2"',
    );
  });

  it('formats ratio scales in incompatibility error messages', async () => {
    const routeA = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDC',
            address: ROUTER_A,
            decimals: 18,
            scale: { numerator: 3, denominator: 2 },
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil2: {
          type: TokenType.crossCollateral,
          owner: ROUTER_A,
          token: ROUTER_A,
          scale: { numerator: 3, denominator: 2 },
        },
      },
    };
    const routeB = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDT',
            address: ROUTER_B,
            decimals: 18,
            scale: 1,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil2: {
          type: TokenType.crossCollateral,
          owner: ROUTER_B,
          token: ROUTER_B,
          scale: 1,
        },
      },
    };

    const { context } = buildContext({
      'route-a': routeA,
      'route-b': routeB,
    });

    let thrown: Error | undefined;
    try {
      await runWarpRouteCombine({
        context,
        routeIds: ['route-a', 'route-b'],
        outputWarpRouteId: 'MULTI/test',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include('scale=3/2');
    expect(thrown?.message).to.include('scale=1');
    expect(thrown?.message).to.not.include('[object Object]');
  });
});
