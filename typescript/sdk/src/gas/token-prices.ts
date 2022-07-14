import { FixedNumber } from 'ethers';
import * as https from 'https';

import { ChainName, NameOrDomain } from '../types';

const CoinGecko = require('coingecko-api');

export interface TokenPriceGetter {
  getTokenPrice(chain: ChainName): Promise<FixedNumber>;
  getTokenExchangeRate(
    chainA: ChainName,
    chainB: ChainName,
  ): Promise<FixedNumber>;
}

// TODO: Consider caching to avoid exceeding CoinGecko's 50 requests / min limit

// TODO implement in following PR
export class DefaultTokenPriceGetter implements TokenPriceGetter {
  async getTokenPrice(chain: ChainName): Promise<FixedNumber> {
    const currency = 'usd';
    const coinGecko = new CoinGecko();
    const response = await coinGecko.simple.price({
      ids: [chain],
      vs_currencies: [currency],
    });
    try {
      return FixedNumber.from(response[chain][currency]);
    } catch (e) {
      throw new Error(
        `Unable to fetch price for ${chain}, received ${response}`,
      );
    }
  }

  async getTokenExchangeRate(
    chainA: ChainName,
    chainB: ChainName,
  ): Promise<FixedNumber> {
    const currency = 'usd';
    const coinGecko = new CoinGecko();
    const response = await coinGecko.simple.price({
      ids: [chainA, chainB],
      vs_currencies: [currency],
    });
    try {
      // This operation is called "unsafe" because of the unintuitive rounding that
      // can occur due to fixed point arithmetic. We're not overly concerned about perfect
      // precision because we're operating with fixed128x18, which has 18 decimals of
      // precision, and gas payments are regardless expected to have a generous buffer to account
      // for movements in native token prices or gas prices.
      // For more details on FixedPoint arithmetic being "unsafe", see
      // https://github.com/ethers-io/ethers.js/issues/1322#issuecomment-787430115.
      const priceA = FixedNumber.from(response[chainA][currency]);
      const priceB = FixedNumber.from(response[chainB][currency]);
      return priceB.divUnsafe(priceA);
    } catch (e) {
      throw new Error(
        `Unable to fetch prices for ${[chainA, chainB]}, received ${response}`,
      );
    }
  }
}
