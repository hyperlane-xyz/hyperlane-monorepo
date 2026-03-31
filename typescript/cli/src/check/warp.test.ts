import { expect } from 'chai';
import sinon from 'sinon';

import { CrossCollateralRouter__factory } from '@hyperlane-xyz/core';
import {
  EvmWarpRouteReader,
  MultiProvider,
  type NormalizedScale,
  TokenType,
  type TokenMetadata,
  type WarpRouteDeployConfigMailboxRequired,
  test1,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { verifyDecimalsAndScale } from './warp.js';

const DOMAIN_BY_CHAIN = {
  anvil2: 31337,
  anvil3: 31338,
} as const;

const MAILBOX = '0x000000000000000000000000000000000000b001';
const OWNER = '0x000000000000000000000000000000000000dEaD';
const ROUTER_B = '0x2222222222222222222222222222222222222222';
const ROUTER_C = '0x3333333333333333333333333333333333333333';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = '0xcccccccccccccccccccccccccccccccccccccccc';

type CrossCollateralRouterConfig = Extract<
  WarpRouteDeployConfigMailboxRequired[string],
  { type: typeof TokenType.crossCollateral }
>;

type VerifyDecimalsAndScaleParams = Parameters<
  typeof verifyDecimalsAndScale
>[0];
type ScaleValidationMultiProvider =
  VerifyDecimalsAndScaleParams['multiProvider'];
type ScaleValidationWarpRouteConfig =
  VerifyDecimalsAndScaleParams['warpRouteConfig'];

type ConfiguredRouterMetadata = {
  wrappedToken: string;
  metadata: TokenMetadata;
  scale?: NormalizedScale;
  error?: Error;
};

function buildMultiProvider(): ScaleValidationMultiProvider {
  return new MultiProvider({
    anvil2: {
      ...test1,
      chainId: DOMAIN_BY_CHAIN.anvil2,
      displayName: 'anvil2',
      domainId: DOMAIN_BY_CHAIN.anvil2,
      name: 'anvil2',
    },
    anvil3: {
      ...test1,
      chainId: DOMAIN_BY_CHAIN.anvil3,
      displayName: 'anvil3',
      domainId: DOMAIN_BY_CHAIN.anvil3,
      name: 'anvil3',
    },
  });
}

function stubConfiguredRouterMetadata(
  routerMetadataByAddress: Record<string, ConfiguredRouterMetadata>,
) {
  const configuredRouters = new Map(
    Object.entries(routerMetadataByAddress).map(([routerAddress, metadata]) => [
      routerAddress.toLowerCase(),
      metadata,
    ]),
  );
  const metadataByWrappedToken = new Map(
    [...configuredRouters.values()].map((metadata) => [
      metadata.wrappedToken.toLowerCase(),
      metadata.metadata,
    ]),
  );

  const connectStub = sinon
    .stub(CrossCollateralRouter__factory, 'connect')
    .callsFake((routerAddress) => {
      const configuredRouter = configuredRouters.get(
        routerAddress.toLowerCase(),
      );
      if (!configuredRouter) {
        throw new Error(`Unexpected router ${routerAddress}`);
      }

      return {
        wrappedToken: async () => {
          if (configuredRouter.error) {
            throw configuredRouter.error;
          }

          return configuredRouter.wrappedToken;
        },
        // CAST: unit test only needs wrappedToken(), which is the only method used here.
      } as ReturnType<typeof CrossCollateralRouter__factory.connect>;
    });
  const metadataStub = sinon
    .stub(EvmWarpRouteReader.prototype, 'fetchERC20Metadata')
    .callsFake(async (wrappedTokenAddress: string) => {
      const metadata = metadataByWrappedToken.get(
        wrappedTokenAddress.toLowerCase(),
      );
      if (!metadata) {
        throw new Error(`Unexpected token ${wrappedTokenAddress}`);
      }

      return metadata;
    });
  const scaleStub = sinon
    .stub(EvmWarpRouteReader.prototype, 'fetchScale')
    .callsFake(async (routerAddress: string) => {
      const configuredRouter = configuredRouters.get(
        routerAddress.toLowerCase(),
      );
      if (!configuredRouter) {
        throw new Error(`Unexpected router ${routerAddress}`);
      }

      return configuredRouter.scale;
    });

  return { connectStub, metadataStub, scaleStub };
}

function buildCrossCollateralConfig({
  token,
  decimals,
  scale,
  crossCollateralRouters,
}: {
  token: string;
  decimals: number;
  scale?: number;
  crossCollateralRouters?: Record<string, string[]>;
}): CrossCollateralRouterConfig {
  return {
    type: TokenType.crossCollateral,
    owner: OWNER,
    token,
    mailbox: MAILBOX,
    name: 'TOKEN',
    symbol: 'TOKEN',
    decimals,
    ...(scale ? { scale } : {}),
    ...(crossCollateralRouters ? { crossCollateralRouters } : {}),
  };
}

describe('verifyDecimalsAndScale', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('passes when an off-subroute configured CCR router shares the same effective scale', async () => {
    const { connectStub, metadataStub, scaleStub } =
      stubConfiguredRouterMetadata({
        [ROUTER_B]: {
          wrappedToken: TOKEN_B,
          metadata: {
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
            isNft: false,
          },
        },
      });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      anvil2: buildCrossCollateralConfig({
        token: TOKEN_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_B)],
        },
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(true);
    expect(
      connectStub.calledOnceWithExactly(ROUTER_B, sinon.match.object),
    ).to.equal(true);
    expect(metadataStub.calledOnceWithExactly(TOKEN_B)).to.equal(true);
    expect(scaleStub.calledOnceWithExactly(ROUTER_B)).to.equal(true);
  });

  it('fails when an off-subroute configured CCR router has mismatched decimals', async () => {
    stubConfiguredRouterMetadata({
      [ROUTER_B]: {
        wrappedToken: TOKEN_B,
        metadata: {
          name: 'TOKEN',
          symbol: 'TOKEN',
          decimals: 8,
          isNft: false,
        },
      },
    });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      anvil2: buildCrossCollateralConfig({
        token: TOKEN_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_B)],
        },
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(false);
  });

  it('includes same-chain CCR routers specified by chain name', async () => {
    const { connectStub } = stubConfiguredRouterMetadata({
      [ROUTER_B]: {
        wrappedToken: TOKEN_B,
        metadata: {
          name: 'TOKEN',
          symbol: 'TOKEN',
          decimals: 18,
          isNft: false,
        },
      },
    });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      anvil2: buildCrossCollateralConfig({
        token: TOKEN_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          anvil2: [addressToBytes32(ROUTER_B)],
        },
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(true);
    expect(
      connectStub.calledOnceWithExactly(ROUTER_B, sinon.match.object),
    ).to.equal(true);
  });

  it('dedupes repeated configured CCR router references', async () => {
    const { connectStub, metadataStub, scaleStub } =
      stubConfiguredRouterMetadata({
        [ROUTER_B]: {
          wrappedToken: TOKEN_B,
          metadata: {
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
            isNft: false,
          },
        },
        [ROUTER_C]: {
          wrappedToken: TOKEN_C,
          metadata: {
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
            isNft: false,
          },
        },
      });

    const repeatedRouter = addressToBytes32(ROUTER_B);
    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      anvil2: buildCrossCollateralConfig({
        token: TOKEN_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [repeatedRouter, repeatedRouter],
          [DOMAIN_BY_CHAIN.anvil2.toString()]: [addressToBytes32(ROUTER_C)],
        },
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(true);
    expect(connectStub.callCount).to.equal(2);
    expect(metadataStub.callCount).to.equal(2);
    expect(scaleStub.callCount).to.equal(2);
  });

  it('throws when a configured CCR router cannot be read', async () => {
    stubConfiguredRouterMetadata({
      [ROUTER_B]: {
        wrappedToken: TOKEN_B,
        metadata: {
          name: 'TOKEN',
          symbol: 'TOKEN',
          decimals: 18,
          isNft: false,
        },
        error: new Error('boom'),
      },
    });

    const warpRouteConfig: ScaleValidationWarpRouteConfig = {
      anvil2: buildCrossCollateralConfig({
        token: TOKEN_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_B)],
        },
      }),
    };

    let thrown: Error | undefined;
    try {
      await verifyDecimalsAndScale({
        multiProvider: buildMultiProvider(),
        warpRouteConfig,
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown?.message).to.equal(
      `Failed to derive configured crossCollateral router ${addressToBytes32(ROUTER_B)} on anvil3: boom`,
    );
  });
});
