import { expect } from 'chai';

import { Chains } from '../consts/chains.js';
import { MockCoinGecko } from '../test/testUtils.js';

import { CoinGeckoTokenPriceGetter } from './token-prices.js';

describe('TokenPriceGetter', () => {
  let tokenPriceGetter: CoinGeckoTokenPriceGetter;
  let mockCoinGecko: MockCoinGecko;
  const chainA = Chains.ethereum,
    chainB = Chains.polygon,
    priceA = 10,
    priceB = 5.5;
  before(async () => {
    mockCoinGecko = new MockCoinGecko();
    // Origin token
    mockCoinGecko.setTokenPrice(chainA, priceA);
    // Destination token
    mockCoinGecko.setTokenPrice(chainB, priceB);
    tokenPriceGetter = new CoinGeckoTokenPriceGetter(
      mockCoinGecko,
      undefined,
      0,
    );
  });

  describe('getTokenPrice', () => {
    it('returns a token price', async () => {
      expect(await tokenPriceGetter.getTokenPrice(chainA)).to.equal(priceA);
    });

    it('caches a token price', async () => {
      mockCoinGecko.setFail(chainA, true);
      expect(await tokenPriceGetter.getTokenPrice(chainA)).to.equal(priceA);
      mockCoinGecko.setFail(chainA, false);
    });
  });

  describe('getTokenExchangeRate', () => {
    it('returns a value consistent with getTokenPrice()', async () => {
      const exchangeRate = await tokenPriceGetter.getTokenExchangeRate(
        chainA,
        chainB,
      );
      const expectedExchangeRate = priceA / priceB;
      expect(exchangeRate).to.equal(expectedExchangeRate);
    });
  });
});
