import { expect } from 'chai';
import sinon from 'sinon';

import { ethereum, solanamainnet } from '@hyperlane-xyz/registry';

import { TestChainName, testChainMetadata } from '../consts/testChains.js';

import { CoinGeckoTokenPriceGetter } from './token-prices.js';

const MOCK_FETCH_CALLS = true;

describe('TokenPriceGetter', () => {
  let tokenPriceGetter: CoinGeckoTokenPriceGetter;

  const chainA = TestChainName.test1;
  const chainB = TestChainName.test2;
  const priceA = 2;
  const priceB = 5;
  let stub: sinon.SinonStub;

  beforeEach(() => {
    tokenPriceGetter = new CoinGeckoTokenPriceGetter({
      // @ts-ignore TODO: remove once merged with main
      chainMetadata: { ethereum, solanamainnet, ...testChainMetadata },
      apiKey: 'test',
      expirySeconds: 10,
      sleepMsBetweenRequests: 10,
    });

    if (MOCK_FETCH_CALLS) {
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .returns(Promise.resolve([priceA, priceB]));
    }
  });

  afterEach(() => {
    if (MOCK_FETCH_CALLS && stub) {
      stub.restore();
    }
  });

  describe('getTokenPriceByIds', () => {
    it('returns token prices', async () => {
      // stubbed results
      expect(
        await tokenPriceGetter.getTokenPriceByIds([
          ethereum.name,
          solanamainnet.name,
        ]),
      ).to.eql([priceA, priceB]);
    });
  });

  describe('getTokenPrice', () => {
    it('returns a token price', async () => {
      // hardcoded result of 1 for testnets
      expect(
        await tokenPriceGetter.getTokenPrice(TestChainName.test1),
      ).to.equal(1);
      // stubbed result for non-testnet
      expect(await tokenPriceGetter.getTokenPrice(ethereum.name)).to.equal(
        priceA,
      );
    });
  });

  describe('getTokenExchangeRate', () => {
    it('returns a value consistent with getTokenPrice()', async () => {
      // hardcoded result of 1 for testnets
      expect(
        await tokenPriceGetter.getTokenExchangeRate(chainA, chainB),
      ).to.equal(1);

      // stubbed result for non-testnet
      expect(
        await tokenPriceGetter.getTokenExchangeRate(
          ethereum.name,
          solanamainnet.name,
        ),
      ).to.equal(priceA / priceB);
    });
  });
});

import { useFakeTimers } from 'sinon';

  describe('caching & expiry', () => {
    const now = Date.now();
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
      clock = useFakeTimers({ now });
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .onCall(0).resolves([priceA, priceB])          // first network hit
        .onCall(1).resolves([priceA + 1, priceB + 1]); // second network hit
    });

    afterEach(() => {
      clock.restore();
      stub.restore();
    });

    it('returns cached values while not expired', async () => {
      const first = await tokenPriceGetter.getTokenPriceByIds([ethereum.name, solanamainnet.name]);
      expect(first).eql([priceA, priceB]);
      const second = await tokenPriceGetter.getTokenPriceByIds([ethereum.name, solanamainnet.name]);
      expect(second).eql(first);            // should come from cache
      expect(stub.callCount).to.equal(1);   // only one network fetch
    });

    it('fetches fresh values after cache expiry', async () => {
      await tokenPriceGetter.getTokenPriceByIds([ethereum.name, solanamainnet.name]);
      clock.tick(11 * 1000); // advance past expirySeconds (10s)
      const refreshed = await tokenPriceGetter.getTokenPriceByIds([ethereum.name, solanamainnet.name]);
      expect(refreshed).eql([priceA + 1, priceB + 1]);
      expect(stub.callCount).to.equal(2);
    });
  });

  describe('error handling', () => {
    it('throws when fetchPriceData rejects', async () => {
      const error = new Error('network down');
      stub = sinon.stub(tokenPriceGetter, 'fetchPriceData').rejects(error);
      await expect(
        tokenPriceGetter.getTokenPriceByIds([ethereum.name]),
      ).to.be.rejectedWith('network down');
    });

    it('throws for unknown chain id', async () => {
      await expect(
        tokenPriceGetter.getTokenPrice('non-existent-chain'),
      ).to.be.rejected;
    });
  });

  describe('rate-limit sleep', () => {
    it('waits sleepMsBetweenRequests between successive uncached calls', async () => {
      const localGetter = new CoinGeckoTokenPriceGetter({
        chainMetadata: { ethereum },
        apiKey: 'key',
        expirySeconds: 0,           // disable cache
        sleepMsBetweenRequests: 50, // expect delay
      });
      const spy = sinon.spy(localGetter as any, 'sleep'); // sleep is internal helper
      sinon.stub(localGetter, 'fetchPriceData').resolves([priceA]);
      await localGetter.getTokenPrice(ethereum.name);
      await localGetter.getTokenPrice(ethereum.name); // second call triggers sleep
      expect(spy.calledOnce).to.be.true;
      expect(spy.firstCall.args[0]).to.equal(50);
    });
  });

  describe('precision of exchange rate', () => {
    it('returns value with sufficient decimal precision', async () => {
      stub = sinon.stub(tokenPriceGetter, 'fetchPriceData').resolves([1, 3]);
      const rate = await tokenPriceGetter.getTokenExchangeRate(ethereum.name, solanamainnet.name);
      expect(rate).to.be.closeTo(1 / 3, 0.000001);
    });
  });