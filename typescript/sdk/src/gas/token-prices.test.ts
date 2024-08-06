import { expect } from 'chai';

import { TestChainName, testChainMetadata } from '../consts/testChains.js';
import { MockCoinGecko } from '../test/MockCoinGecko.js';

import { CoinGeckoTokenPriceGetter } from './token-prices.js';

describe('TokenPriceGetter', () => {
  let tokenPriceGetter: CoinGeckoTokenPriceGetter;
  let mockCoinGecko: MockCoinGecko;
  const chainA = TestChainName.test1,
    chainB = TestChainName.test2,
    priceA = 1,
    priceB = 5.5;
  before(async () => {
    mockCoinGecko = new MockCoinGecko();
    // Origin token
    mockCoinGecko.setTokenPrice(chainA, priceA);
    // Destination token
    mockCoinGecko.setTokenPrice(chainB, priceB);
    tokenPriceGetter = new CoinGeckoTokenPriceGetter(
      mockCoinGecko,
      testChainMetadata,
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
      // Should equal 1 because testnet prices are always forced to 1
      expect(exchangeRate).to.equal(1);
    });
  });
});
