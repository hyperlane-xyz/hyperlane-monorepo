import { expect } from 'chai';

import { Chains } from '../consts/chains';
import { MockCoinGecko } from '../test/testUtils';

import { CoinGeckoTokenPriceGetter } from './token-prices';

describe('TokenPriceGetter', () => {
  let tokenPriceGetter: CoinGeckoTokenPriceGetter;
  const chainA = Chains.ethereum,
    chainB = Chains.polygon,
    priceA = 10,
    priceB = 5.5;
  beforeEach(async () => {
    const mockCoinGecko = new MockCoinGecko();
    // Origin token
    mockCoinGecko.setTokenPrice(chainA, priceA);
    // Destination token
    mockCoinGecko.setTokenPrice(chainB, priceB);
    tokenPriceGetter = new CoinGeckoTokenPriceGetter(mockCoinGecko);
  });

  describe('getTokenPrice', () => {
    it('returns a token price', async () => {
      expect(await tokenPriceGetter.getTokenPrice(chainA)).to.equal(priceA);
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
