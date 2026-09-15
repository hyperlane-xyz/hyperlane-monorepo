import { expect } from 'chai';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { ChainName, Token, WarpCore } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MonitorEventType } from '../interfaces/IMonitor.js';
import { Monitor } from './Monitor.js';

const logger = pino({ level: 'silent' });

type TestToken = Token & { bridgedSupplyStub: Sinon.SinonStub };

function createToken(chainName: ChainName, symbol: string): TestToken {
  const getBridgedSupply = Sinon.stub();
  return {
    chainName,
    symbol,
    name: symbol,
    decimals: 18,
    addressOrDenom: `0x${symbol.padEnd(40, '0')}`,
    protocol: ProtocolType.Ethereum,
    isHypToken: () => true,
    getHypAdapter: () => ({ getBridgedSupply }),
    bridgedSupplyStub: getBridgedSupply,
    // Monitor only reads this Token subset in these unit tests.
  } as unknown as TestToken;
}

function createMultiProvider() {
  return {
    getChainMetadata: (chain: ChainName) => ({
      protocol: ProtocolType.Ethereum,
      blocks: { reorgPeriod: chain === 'ethereum' ? 10 : 20 },
    }),
    getEthersV5Provider: (chain: ChainName) => ({
      getBlockNumber: async () => (chain === 'ethereum' ? 100 : 200),
    }),
  };
}

describe('Monitor', () => {
  afterEach(() => {
    Sinon.restore();
  });

  it('preserves token order and uses confirmed block tags per token chain', async () => {
    const ethereumToken = createToken('ethereum', 'ETH');
    const arbitrumToken = createToken('arbitrum', 'ARB');
    const secondEthereumToken = createToken('ethereum', 'ETH2');
    ethereumToken.bridgedSupplyStub.resolves(100n);
    arbitrumToken.bridgedSupplyStub.resolves(200n);
    secondEthereumToken.bridgedSupplyStub.resolves(300n);

    const warpCore = {
      tokens: [ethereumToken, arbitrumToken, secondEthereumToken],
      multiProvider: createMultiProvider(),
      // Monitor only reads tokens and multiProvider in these unit tests.
    } as unknown as WarpCore;
    const monitor = new Monitor(0, warpCore, logger);

    const eventPromise = new Promise<unknown>((resolve) => {
      monitor.on(MonitorEventType.TokenInfo, (event) => {
        resolve(event);
        void monitor.stop();
      });
    });

    await monitor.start();
    const event = (await eventPromise) as {
      tokensInfo: Array<{ token: Token; bridgedSupply: bigint }>;
      confirmedBlockTags: Record<string, number>;
    };

    expect(event.tokensInfo.map(({ token }) => token.symbol)).to.deep.equal([
      'ETH',
      'ARB',
      'ETH2',
    ]);
    expect(event.tokensInfo.map(({ bridgedSupply }) => bridgedSupply)).to.eql([
      100n,
      200n,
      300n,
    ]);
    expect(event.confirmedBlockTags).to.deep.equal({
      ethereum: 90,
      arbitrum: 180,
    });
    expect(
      ethereumToken.bridgedSupplyStub.calledWithExactly({ blockTag: 90 }),
    ).to.equal(true);
    expect(
      arbitrumToken.bridgedSupplyStub.calledWithExactly({ blockTag: 180 }),
    ).to.equal(true);
    expect(
      secondEthereumToken.bridgedSupplyStub.calledWithExactly({
        blockTag: 90,
      }),
    ).to.equal(true);
  });

  it('limits bridged supply reads to eight at a time', async () => {
    const tokens = Array.from({ length: 10 }, (_, index) =>
      createToken('ethereum', `T${index}`),
    );
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseReads: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let resolveLimitReached: () => void;
    const limitReached = new Promise<void>((resolve) => {
      resolveLimitReached = resolve;
    });

    tokens.forEach((token, index) => {
      token.bridgedSupplyStub.callsFake(async () => {
        active += 1;
        started += 1;
        maxActive = Math.max(maxActive, active);
        if (started === 8) resolveLimitReached();
        await readsReleased;
        active -= 1;
        return BigInt(index);
      });
    });

    const warpCore = {
      tokens,
      multiProvider: createMultiProvider(),
    } as unknown as WarpCore;
    const monitor = new Monitor(0, warpCore, logger);
    const eventPromise = new Promise<unknown>((resolve) => {
      monitor.on(MonitorEventType.TokenInfo, (event) => {
        resolve(event);
        void monitor.stop();
      });
    });

    const startPromise = monitor.start();
    await limitReached;
    expect(started).to.equal(8);
    releaseReads!();
    const event = (await eventPromise) as {
      tokensInfo: Array<{ bridgedSupply: bigint }>;
    };
    await startPromise;

    expect(maxActive).to.equal(8);
    expect(event.tokensInfo.map(({ bridgedSupply }) => bridgedSupply)).to.eql(
      Array.from({ length: 10 }, (_, index) => BigInt(index)),
    );
  });
});
