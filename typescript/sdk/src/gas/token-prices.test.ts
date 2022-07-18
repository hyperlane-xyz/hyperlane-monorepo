import { expect } from 'chai';

import { AllChains, Chains } from '../consts/chains';

import { DefaultTokenPriceGetter } from './token-prices';

describe('TokenPriceGetter', () => {
  let tokenPriceGetter: DefaultTokenPriceGetter;
  beforeEach(() => {
    tokenPriceGetter = new DefaultTokenPriceGetter();
  });

  describe('getTokenPrice', () => {
    it('returns a value for each supported chain', async () => {
      for (const chain of AllChains) {
        await tokenPriceGetter.getTokenPrice(chain);
      }
    });
  });

  describe('getTokenExchangeRate', () => {
    it('returns a value consistent with getTokenPrice()', async () => {
      const ethPrice = await tokenPriceGetter.getTokenPrice(Chains.ethereum);
      const maticPrice = await tokenPriceGetter.getTokenPrice(Chains.polygon);
      const exchangeRate = await tokenPriceGetter.getTokenExchangeRate(
        Chains.ethereum,
        Chains.polygon,
      );
      const expectedExchangeRate = maticPrice / ethPrice;
      const relativeDifference = exchangeRate / expectedExchangeRate;
      // Price movements between fetching individual prices and the exchange
      // rate should result in exchange rates that differ by no more than
      // 1%.
      expect(relativeDifference).to.be.closeTo(1, 0.01);
    });
  });
});
