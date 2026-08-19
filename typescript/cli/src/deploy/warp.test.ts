import { expect } from 'chai';
import sinon from 'sinon';

import {
  ProtocolType,
  addressToBytes32,
  rootLogger,
} from '@hyperlane-xyz/utils';
import {
  EvmWarpModule,
  HyperlaneDeployer,
  HookType,
  IsmType,
  MultiProvider,
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';

import {
  fullyConnectTokens,
  runWarpRouteApply,
  runWarpRouteCombine,
  runWarpUpdatePlanning,
  transformDeployConfigForDisplay,
  withIntermediateWarpOwner,
} from './warp.js';

describe('fullyConnectTokens', () => {
  it('does not connect operational ALRB entries', () => {
    const warpCoreConfig: WarpCoreConfig = {
      tokens: [
        buildCrossCollateralToken({
          chainName: 'anvil2',
          symbol: 'USDC',
          address: '0x1111111111111111111111111111111111111111',
          decimals: 6,
        }),
        buildCrossCollateralToken({
          chainName: 'anvil3',
          symbol: 'USDT',
          address: '0x2222222222222222222222222222222222222222',
          decimals: 6,
        }),
        {
          chainName: 'anvil4',
          standard: TokenStandard.EvmAtomicLocalRebalancingBridge,
          tokenType: TokenType.atomicLocalRebalancing,
          decimals: 6,
          symbol: 'ALRB',
          name: 'Atomic Local Rebalancing Bridge',
          addressOrDenom: '0x3333333333333333333333333333333333333333',
        },
      ],
    };
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProtocol.returns(ProtocolType.Ethereum);

    fullyConnectTokens(warpCoreConfig, multiProvider);

    expect(warpCoreConfig.tokens[0].connections).to.have.length(1);
    expect(warpCoreConfig.tokens[1].connections).to.have.length(1);
    expect(warpCoreConfig.tokens[2].connections).to.equal(undefined);
    expect(
      warpCoreConfig.tokens
        .flatMap((token) => token.connections ?? [])
        .some((connection) =>
          connection.token.endsWith(
            '0x3333333333333333333333333333333333333333',
          ),
        ),
    ).to.equal(false);
  });
});

describe('withIntermediateWarpOwner', () => {
  it('rewrites the router and nested hybrid owners for extension deployment', () => {
    const finalOwner = '0x1111111111111111111111111111111111111111';
    const intermediateOwner = '0x2222222222222222222222222222222222222222';
    const config: WarpRouteDeployConfigMailboxRequired[string] = {
      type: TokenType.synthetic,
      mailbox: '0x3333333333333333333333333333333333333333',
      owner: finalOwner,
      interchainSecurityModule: {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          {
            type: IsmType.TRUSTED_RELAYER,
            relayer: '0x4444444444444444444444444444444444444444',
          },
          {
            type: IsmType.NET_FLOW_RATE_LIMITED,
            thresholdBps: 500,
            duration: 86400n,
            owner: finalOwner,
          },
        ],
      },
      hook: {
        type: HookType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
        owner: finalOwner,
      },
    };

    expect(withIntermediateWarpOwner(config, intermediateOwner)).to.deep.equal({
      ...config,
      owner: intermediateOwner,
      interchainSecurityModule: {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          {
            type: IsmType.TRUSTED_RELAYER,
            relayer: '0x4444444444444444444444444444444444444444',
          },
          {
            type: IsmType.NET_FLOW_RATE_LIMITED,
            thresholdBps: 500,
            duration: 86400n,
            owner: intermediateOwner,
          },
        ],
      },
      hook: {
        type: HookType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
        owner: intermediateOwner,
      },
    });
  });
});

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

describe('runWarpRouteApply', () => {
  const OWNER = '0x3333333333333333333333333333333333333333';
  const MAILBOX = '0x2222222222222222222222222222222222222222';

  afterEach(() => {
    sinon.restore();
  });

  it('rejects mixed AltVM timelock config before extension or update planning', async () => {
    const registryGetAddresses = sinon.stub().resolves({});
    const updateSplitSpy = sinon.spy(EvmWarpModule.prototype, 'updateSplit');
    const deployTimelockSpy = sinon.spy(
      HyperlaneDeployer.prototype,
      'deployTimelock',
    );
    const multiProvider = {
      tryGetProtocol: (chain: string) =>
        chain === 'solana' ? ProtocolType.Sealevel : ProtocolType.Ethereum,
    };
    const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
      ethereum: {
        mailbox: MAILBOX,
        owner: OWNER,
        type: TokenType.native,
      },
      solana: {
        mailbox: MAILBOX,
        owner: OWNER,
        timelock: {
          delay: 259200,
          roles: {
            executor: OWNER,
            proposer: OWNER,
          },
        },
        type: TokenType.native,
      },
    };
    const warpCoreConfig: WarpCoreConfig = {
      tokens: [],
    };

    try {
      await runWarpRouteApply({
        context: {
          altVmSigners: {},
          chainMetadata: {},
          // CAST: runWarpRouteApply rejects after the protocol guard, before using the full MultiProvider surface.
          multiProvider,
          registry: {
            getAddresses: registryGetAddresses,
          },
          skipConfirmation: true,
        },
        warpCoreConfig,
        warpDeployConfig,
        // CAST: runWarpRouteApply rejects before reading the remaining DeployParams fields.
      } as unknown as Parameters<typeof runWarpRouteApply>[0]);
      expect.fail('expected AltVM timelock config to reject');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.include(
        "Timelock config is not supported on Alt-VM chain 'solana'",
      );
      expect(registryGetAddresses.called).to.equal(false);
      expect(updateSplitSpy.called).to.equal(false);
      expect(deployTimelockSpy.called).to.equal(false);
    }
  });
});

describe('runWarpUpdatePlanning', () => {
  for (const protocolType of [ProtocolType.Ethereum, ProtocolType.Tron]) {
    it(`does not retry ${protocolType} planning after a deployment followed by failure`, async () => {
      const runner = sinon
        .stub()
        .rejects(new Error('failure after deployment'));

      let message = '';
      try {
        await runWarpUpdatePlanning(protocolType, runner);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).to.equal('failure after deployment');
      expect(runner.calledOnce).to.equal(true);
    });
  }

  it('retains retries for AltVM planning', async () => {
    const runner = sinon.stub();
    runner.onFirstCall().rejects(new Error('transient read failure'));
    runner.onSecondCall().resolves('planned');

    expect(await runWarpUpdatePlanning(ProtocolType.Sealevel, runner)).to.equal(
      'planned',
    );
    expect(runner.callCount).to.equal(2);
  });
});

describe('transformDeployConfigForDisplay', () => {
  const OWNER = '11111111111111111111111111111111111111111';
  const MAILBOX = '22222222222222222222222222222222222222222';
  const RELAYER = '33333333333333333333333333333333333333333';

  it('recurses into routing/fallbackRouting domain sub-nodes of a composite ISM', () => {
    const deployConfig: WarpRouteDeployConfigMailboxRequired = {
      solanamainnet: {
        type: TokenType.synthetic,
        owner: OWNER,
        mailbox: MAILBOX,
        interchainSecurityModule: {
          type: IsmType.COMPOSITE,
          owner: OWNER,
          root: {
            type: 'routing',
            domains: {
              ethereum: {
                type: 'multisigMessageId',
                validators: [RELAYER],
                threshold: 1,
              },
            },
          },
        },
      },
    };

    const { transformedIsmConfigs } =
      transformDeployConfigForDisplay(deployConfig);

    const rows = transformedIsmConfigs.solanamainnet;
    expect(rows.some((row) => row.Type === 'multisigMessageId')).to.equal(true);
  });

  it('tags each domain row with its own path when multiple domains have distinct configs', () => {
    const RELAYER_2 = '44444444444444444444444444444444444444444';
    const deployConfig: WarpRouteDeployConfigMailboxRequired = {
      solanamainnet: {
        type: TokenType.synthetic,
        owner: OWNER,
        mailbox: MAILBOX,
        interchainSecurityModule: {
          type: IsmType.COMPOSITE,
          owner: OWNER,
          root: {
            type: 'routing',
            domains: {
              ethereum: {
                type: 'multisigMessageId',
                validators: [RELAYER],
                threshold: 1,
              },
              polygon: {
                type: 'trustedRelayer',
                relayer: RELAYER_2,
              },
            },
          },
        },
      },
    };

    const { transformedIsmConfigs } =
      transformDeployConfigForDisplay(deployConfig);

    const rows = transformedIsmConfigs.solanamainnet;
    const ethereumRow = rows.find(
      (row) =>
        row.Path === 'root.domains.ethereum' &&
        row.Type === 'multisigMessageId',
    );
    const polygonRow = rows.find(
      (row) =>
        row.Path === 'root.domains.polygon' && row.Type === 'trustedRelayer',
    );
    expect(ethereumRow?.Validators).to.deep.equal([RELAYER]);
    expect(polygonRow?.Relayer).to.equal(RELAYER_2);
  });

  it('disambiguates a nested tree via Path when sibling rows would otherwise collide', () => {
    const deployConfig: WarpRouteDeployConfigMailboxRequired = {
      solanamainnet: {
        type: TokenType.synthetic,
        owner: OWNER,
        mailbox: MAILBOX,
        interchainSecurityModule: {
          type: IsmType.COMPOSITE,
          owner: OWNER,
          root: {
            type: 'aggregation',
            threshold: 1,
            subIsms: [
              {
                type: 'amountRouting',
                threshold: '1000',
                lower: { type: 'test', accept: true },
                upper: { type: 'test', accept: false },
              },
              { type: 'trustedRelayer', relayer: RELAYER },
            ],
          },
        },
      },
    };

    const { transformedIsmConfigs } =
      transformDeployConfigForDisplay(deployConfig);

    const rows = transformedIsmConfigs.solanamainnet;
    const lowerRow = rows.find(
      (row) => row.Path === 'root.subIsms[0].lower' && row.Type === 'test',
    );
    const upperRow = rows.find(
      (row) => row.Path === 'root.subIsms[0].upper' && row.Type === 'test',
    );
    const relayerRow = rows.find(
      (row) => row.Path === 'root.subIsms[1]' && row.Type === 'trustedRelayer',
    );
    expect(lowerRow?.Accept).to.equal(true);
    expect(upperRow?.Accept).to.equal(false);
    expect(relayerRow?.Relayer).to.equal(RELAYER);
  });
});
