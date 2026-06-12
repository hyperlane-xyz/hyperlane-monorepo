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
  } as unknown as TestToken;
}

describe('Monitor', () => {
  afterEach(() => {
    Sinon.restore();
  });

  it('preserves token order and uses confirmed block tags per token chain', async () => {
    const ethereumToken = createToken('ethereum' as ChainName, 'ETH');
    const arbitrumToken = createToken('arbitrum' as ChainName, 'ARB');
    const secondEthereumToken = createToken('ethereum' as ChainName, 'ETH2');
    ethereumToken.bridgedSupplyStub.resolves(100n);
    arbitrumToken.bridgedSupplyStub.resolves(200n);
    secondEthereumToken.bridgedSupplyStub.resolves(300n);

    const multiProvider = {
      getChainMetadata: (chain: ChainName) => ({
        protocol: ProtocolType.Ethereum,
        blocks: { reorgPeriod: chain === 'ethereum' ? 10 : 20 },
      }),
      getEthersV5Provider: (chain: ChainName) => ({
        getBlockNumber: async () => (chain === 'ethereum' ? 100 : 200),
      }),
    };
    const warpCore = {
      tokens: [ethereumToken, arbitrumToken, secondEthereumToken],
      multiProvider,
    } as unknown as WarpCore;
    const monitor = new Monitor(0, warpCore, logger);

    const eventPromise = new Promise<unknown>((resolve) => {
      monitor.on(MonitorEventType.TokenInfo, async (event) => {
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
    expect(
      event.tokensInfo.map(({ token, bridgedSupply }) => ({
        token: token.symbol,
        bridgedSupply,
      })),
    ).to.deep.equal([
      { token: 'ETH', bridgedSupply: 100n },
      { token: 'ARB', bridgedSupply: 200n },
      { token: 'ETH2', bridgedSupply: 300n },
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
});
