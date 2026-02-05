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

    it('returns stale cached prices when API fails', async () => {
      // First call succeeds and populates cache
      expect(
        await tokenPriceGetter.getTokenPriceByIds(['ethereum', 'solana']),
      ).to.eql([priceA, priceB]);

      // Subsequent call fails (simulate 429 rate limiting)
      stub.restore();
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .rejects(new Error('No price found for ethereum'));

      // Cache entries are stale (past freshSeconds) but not evicted,
      // so the fallback should return them.
      // We use expirySeconds=10 in beforeEach so freshness window is 10s;
      // eviction is 3h default, so cached values are still valid.
      const result = await tokenPriceGetter.getTokenPriceByIds([
        'ethereum',
        'solana',
      ]);
      expect(result).to.eql([priceA, priceB]);
    });

    it('returns undefined when API fails with no cache', async () => {
      // Make the very first call fail — nothing in cache
      stub.restore();
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .rejects(new Error('No price found for ethereum'));

      const result = await tokenPriceGetter.getTokenPriceByIds([
        'ethereum',
        'solana',
      ]);
      expect(result).to.be.undefined;
    });

    it('returns undefined when API fails and cache is only partial', async () => {
      // Populate cache for ethereum only
      stub.restore();
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .resolves([priceA]);
      await tokenPriceGetter.getTokenPriceByIds(['ethereum']);

      // Now fail when querying both
      stub.restore();
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .rejects(new Error('rate limited'));

      const result = await tokenPriceGetter.getTokenPriceByIds([
        'ethereum',
        'solana',
      ]);
      // solana was never cached, so we cannot serve the full set
      expect(result).to.be.undefined;
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
