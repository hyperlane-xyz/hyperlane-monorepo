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

  describe('prefetchTokenPrices / getCachedTokenPrice', () => {
    let fetchStub: sinon.SinonStub;

    afterEach(() => {
      fetchStub?.restore();
    });

    it('warms the cache in one deduped batched pass', async () => {
      fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(
          JSON.stringify({
            ethereum: { usd: 1900 },
            bitcoin: { usd: 64000 },
          }),
          { status: 200 },
        ),
      );

      await tokenPriceGetter.prefetchTokenPrices([
        'ethereum',
        'bitcoin',
        'ethereum',
      ]);

      expect(fetchStub.callCount).to.equal(1);
      expect(tokenPriceGetter.getCachedTokenPrice('ethereum')).to.equal(1900);
      expect(tokenPriceGetter.getCachedTokenPrice('bitcoin')).to.equal(64000);
    });

    it('skips ids with no returned price instead of dropping the batch', async () => {
      fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(JSON.stringify({ ethereum: { usd: 1900 } }), {
          status: 200,
        }),
      );

      await tokenPriceGetter.prefetchTokenPrices(['ethereum', 'unknown-token']);

      expect(tokenPriceGetter.getCachedTokenPrice('ethereum')).to.equal(1900);
      expect(tokenPriceGetter.getCachedTokenPrice('unknown-token')).to.equal(
        undefined,
      );
    });

    it('chunks id lists that exceed the per-call limit', async () => {
      // A list longer than the per-call cap must be split across requests
      // rather than sent as one oversized (and rejected) batch.
      fetchStub = sinon
        .stub(globalThis, 'fetch')
        .callsFake(
          async () => new Response(JSON.stringify({}), { status: 200 }),
        );

      const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
      await tokenPriceGetter.prefetchTokenPrices(ids);

      // 150 ids at a 100-per-call cap => 2 requests.
      expect(fetchStub.callCount).to.equal(2);
    });
  });
});
