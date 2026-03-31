import { expect } from 'chai';
import sinon from 'sinon';

import {
  EvmWarpRouteReader,
  type HypTokenRouterVirtualConfig,
  TokenType,
  type WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { verifyDecimalsAndScale } from './warp.js';

const DOMAIN_BY_CHAIN = {
  anvil2: 31337,
  anvil3: 31338,
} as const;

const CHAIN_BY_DOMAIN = {
  [DOMAIN_BY_CHAIN.anvil2]: 'anvil2',
  [DOMAIN_BY_CHAIN.anvil3]: 'anvil3',
} as const;

const MAILBOX = '0x000000000000000000000000000000000000b001';
const OWNER = '0x000000000000000000000000000000000000dEaD';
const ROUTER_A = '0x1111111111111111111111111111111111111111';
const ROUTER_B = '0x2222222222222222222222222222222222222222';
const ROUTER_C = '0x3333333333333333333333333333333333333333';

type CrossCollateralRouterConfig = Extract<
  WarpRouteDeployConfigMailboxRequired[string],
  { type: typeof TokenType.crossCollateral }
>;

function buildMultiProvider() {
  return {
    getProvider: sinon.stub().returns({}),
    tryGetRpcConcurrency: sinon.stub().returns(undefined),
    getChainName: sinon.stub().callsFake((domain: number) => {
      const chain = CHAIN_BY_DOMAIN[domain as keyof typeof CHAIN_BY_DOMAIN];
      if (!chain) throw new Error(`Unknown domain ${domain}`);
      return chain;
    }),
    getChainMetadata: sinon.stub().callsFake((chain: string) => {
      const domainId = DOMAIN_BY_CHAIN[chain as keyof typeof DOMAIN_BY_CHAIN];
      if (!domainId) throw new Error(`Unknown chain ${chain}`);
      return { domainId };
    }),
  } as any;
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

  it('passes when top-level routes and configured CCR routers share one effective scale', async () => {
    const deriveStub = sinon
      .stub(EvmWarpRouteReader.prototype, 'deriveWarpRouteConfig')
      .callsFake(async function (this: any, address: string) {
        if (this.chain === 'anvil3' && address.toLowerCase() === ROUTER_B) {
          return {
            type: TokenType.crossCollateral,
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
          } as any;
        }
        throw new Error(`Unexpected router ${address} on ${this.chain}`);
      });

    const warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
      Record<string, Partial<HypTokenRouterVirtualConfig>> = {
      anvil2: buildCrossCollateralConfig({
        token: ROUTER_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_B)],
        },
      }),
      anvil3: buildCrossCollateralConfig({
        token: ROUTER_B,
        decimals: 18,
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(true);
    expect(deriveStub.calledOnceWithExactly(ROUTER_B)).to.equal(true);
  });

  it('fails when a configured CCR router has mismatched decimals/scale', async () => {
    sinon
      .stub(EvmWarpRouteReader.prototype, 'deriveWarpRouteConfig')
      .callsFake(async function (this: any, address: string) {
        if (this.chain === 'anvil3' && address.toLowerCase() === ROUTER_B) {
          return {
            type: TokenType.crossCollateral,
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 8,
          } as any;
        }
        throw new Error(`Unexpected router ${address} on ${this.chain}`);
      });

    const warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
      Record<string, Partial<HypTokenRouterVirtualConfig>> = {
      anvil2: buildCrossCollateralConfig({
        token: ROUTER_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [addressToBytes32(ROUTER_B)],
        },
      }),
      anvil3: buildCrossCollateralConfig({
        token: ROUTER_B,
        decimals: 18,
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(false);
  });

  it('includes same-chain CCR routers specified by chain name', async () => {
    const deriveStub = sinon
      .stub(EvmWarpRouteReader.prototype, 'deriveWarpRouteConfig')
      .callsFake(async function (this: any, address: string) {
        if (this.chain === 'anvil2' && address.toLowerCase() === ROUTER_B) {
          return {
            type: TokenType.crossCollateral,
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
          } as any;
        }
        throw new Error(`Unexpected router ${address} on ${this.chain}`);
      });

    const warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
      Record<string, Partial<HypTokenRouterVirtualConfig>> = {
      anvil2: buildCrossCollateralConfig({
        token: ROUTER_A,
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
    expect(deriveStub.calledOnceWithExactly(ROUTER_B)).to.equal(true);
  });

  it('dedupes repeated configured CCR router references', async () => {
    const deriveStub = sinon
      .stub(EvmWarpRouteReader.prototype, 'deriveWarpRouteConfig')
      .callsFake(async function (this: any, address: string) {
        if (this.chain === 'anvil3' && address.toLowerCase() === ROUTER_B) {
          return {
            type: TokenType.crossCollateral,
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
          } as any;
        }
        if (this.chain === 'anvil2' && address.toLowerCase() === ROUTER_C) {
          return {
            type: TokenType.crossCollateral,
            name: 'TOKEN',
            symbol: 'TOKEN',
            decimals: 18,
          } as any;
        }
        throw new Error(`Unexpected router ${address} on ${this.chain}`);
      });

    const repeatedRouter = addressToBytes32(ROUTER_B);
    const warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
      Record<string, Partial<HypTokenRouterVirtualConfig>> = {
      anvil2: buildCrossCollateralConfig({
        token: ROUTER_A,
        decimals: 6,
        scale: 1_000_000_000_000,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil3.toString()]: [repeatedRouter, repeatedRouter],
        },
      }),
      anvil3: buildCrossCollateralConfig({
        token: ROUTER_B,
        decimals: 18,
        crossCollateralRouters: {
          [DOMAIN_BY_CHAIN.anvil2.toString()]: [addressToBytes32(ROUTER_C)],
        },
      }),
    };

    const isValid = await verifyDecimalsAndScale({
      multiProvider: buildMultiProvider(),
      warpRouteConfig,
    });

    expect(isValid).to.equal(true);
    expect(deriveStub.callCount).to.equal(2);
  });

  it('throws when a configured CCR router cannot be read', async () => {
    sinon
      .stub(EvmWarpRouteReader.prototype, 'deriveWarpRouteConfig')
      .rejects(new Error('boom'));

    const warpRouteConfig: WarpRouteDeployConfigMailboxRequired &
      Record<string, Partial<HypTokenRouterVirtualConfig>> = {
      anvil2: buildCrossCollateralConfig({
        token: ROUTER_A,
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
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal(
      `Failed to derive configured crossCollateral router ${addressToBytes32(ROUTER_B)} on anvil3: boom`,
    );
  });
});
