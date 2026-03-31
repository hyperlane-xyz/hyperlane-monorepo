import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import {
  CrossCollateralRouter__factory,
  ERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ProtocolType,
  addressToBytes32,
  normalizeAddressEvm,
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
  const metadataByRouter = new Map<
    string,
    {
      decimals: number;
      scale?: number | { numerator: number; denominator: number };
      symbol: string;
    }
  >();

  for (const route of Object.values(routes)) {
    for (const token of route.coreConfig.tokens) {
      metadataByRouter.set(normalizeAddressEvm(token.addressOrDenom!), {
        decimals: token.decimals,
        scale: token.scale,
        symbol: token.symbol,
      });
    }
  }

  sinon
    .stub(CrossCollateralRouter__factory, 'connect')
    .callsFake((routerAddress: string) => {
      const normalizedAddress = normalizeAddressEvm(routerAddress);
      const metadata = metadataByRouter.get(normalizedAddress);
      const scale = metadata?.scale;
      const scaleNumerator =
        typeof scale === 'object' ? scale.numerator : (scale ?? 1);
      const scaleDenominator =
        typeof scale === 'object' ? scale.denominator : 1;
      return {
        wrappedToken: sinon.stub().resolves(normalizedAddress),
        scaleNumerator: sinon.stub().resolves(BigNumber.from(scaleNumerator)),
        scaleDenominator: sinon
          .stub()
          .resolves(BigNumber.from(scaleDenominator)),
      } as any;
    });
  sinon.stub(ERC20__factory, 'connect').callsFake((tokenAddress: string) => {
    const metadata = metadataByRouter.get(normalizeAddressEvm(tokenAddress));
    return {
      decimals: sinon.stub().resolves(metadata?.decimals),
      symbol: sinon.stub().resolves(metadata?.symbol),
    } as any;
  });
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
        getChainName(domainId: number) {
          return Object.entries(DOMAIN_BY_CHAIN).find(
            ([, domain]) => domain === domainId,
          )?.[0];
        },
        getChainMetadata(chain: string) {
          return {
            domainId: DOMAIN_BY_CHAIN[chain],
            name: chain,
            protocol: ProtocolType.Ethereum,
          };
        },
        getProtocol() {
          return ProtocolType.Ethereum;
        },
        getProvider(chain: string) {
          return chain;
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

  it('rejects routes with incompatible decimals/scale in the combined graph', async () => {
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
      'Incompatible CrossCollateralRouter decimals/scale',
    );
  });

  it('rejects incompatible graphs even when routes do not overlap on the same chain', async () => {
    const routeA = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil2',
            symbol: 'USDC',
            address: ROUTER_A,
            decimals: 18,
          }),
          buildCrossCollateralToken({
            chainName: 'anvil3',
            symbol: 'USDC',
            address: ROUTER_B,
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
        },
        anvil3: {
          type: TokenType.crossCollateral,
          owner: ROUTER_B,
          token: ROUTER_B,
          scale: 1_000_000_000_000,
        },
      },
    };
    const routeB = {
      coreConfig: {
        tokens: [
          buildCrossCollateralToken({
            chainName: 'anvil4',
            symbol: 'USDT',
            address: ROUTER_C,
            decimals: 18,
            scale: 2,
          }),
        ],
      } as WarpCoreConfig,
      deployConfig: {
        anvil4: {
          type: TokenType.crossCollateral,
          owner: ROUTER_C,
          token: ROUTER_C,
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
      'Incompatible CrossCollateralRouter decimals/scale',
    );
  });
});
