import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName, testChainMetadata } from '../consts/testChains.js';

import { CoinGeckoTokenPriceGetter } from './token-prices.js';

const MOCK_FETCH_CALLS = true;

const ethereum: { name?: string } = {};
const solanamainnet: { name?: string } = {};

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
        await tokenPriceGetter.getTokenPriceByIds(['ethereum', 'solana']),
      ).to.eql([priceA, priceB]);
    });

    it('returns stale cached prices on API failure', async () => {
      // First call populates cache (real timers)
      await tokenPriceGetter.getTokenPriceByIds(['ethereum', 'solana']);

      // Jump 15s ahead — past freshSeconds (10s) but before evictionSeconds (3h).
      // This forces isFresh() to return false so the fetch path is actually hit.
      const clock = sinon.useFakeTimers(Date.now() + 15_000);
      try {
        stub.rejects(new Error('429 Too Many Requests'));
        const promise = tokenPriceGetter.getTokenPriceByIds([
          'ethereum',
          'solana',
        ]);
        // Resolve the internal sleep(10) timer
        await clock.tickAsync(10);
        const result = await promise;
        expect(result).to.eql([priceA, priceB]);
      } finally {
        clock.restore();
      }
    });

    it('returns undefined on API failure with no cache', async () => {
      stub.rejects(new Error('429 Too Many Requests'));
      const result = await tokenPriceGetter.getTokenPriceByIds([
        'ethereum',
        'solana',
      ]);
      expect(result).to.be.undefined;
    });

    it('returns undefined on API failure with partial cache', async () => {
      // Populate cache for ethereum only
      stub.resolves([priceA]);
      await tokenPriceGetter.getTokenPriceByIds(['ethereum']);

      // Jump past freshSeconds so both IDs need re-fetching
      const clock = sinon.useFakeTimers(Date.now() + 15_000);
      try {
        stub.rejects(new Error('429 Too Many Requests'));
        const promise = tokenPriceGetter.getTokenPriceByIds([
          'ethereum',
          'solana',
        ]);
        await clock.tickAsync(10);
        const result = await promise;
        // solana was never cached, so we cannot serve the full set
        expect(result).to.be.undefined;
      } finally {
        clock.restore();
      }
    });
  });

  describe('getTokenPrice', () => {
    it('returns a token price', async () => {
      // hardcoded result of 1 for testnets
      expect(
        await tokenPriceGetter.getTokenPrice(TestChainName.test1),
      ).to.equal(1);
      // stubbed result for non-testnet
      expect(await tokenPriceGetter.getTokenPrice('ethereum')).to.equal(priceA);
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
          'ethereum',
          'solanamainnet',
        ),
      ).to.equal(priceA / priceB);
    });
  });
});
