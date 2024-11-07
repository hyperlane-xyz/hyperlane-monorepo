import { SimplePriceResponse } from 'coingecko-api-v3';

import type {
  CoinGeckoInterface,
  CoinGeckoResponse,
  CoinGeckoSimplePriceInterface,
  CoinGeckoSimplePriceParams,
} from '../gas/token-prices.js';
import type { ChainName } from '../types.js';

// A mock CoinGecko intended to be used by tests
export class MockCoinGecko implements CoinGeckoInterface {
  // Prices keyed by coingecko id
  private tokenPrices: Record<string, number>;
  // Whether or not to fail to return a response, keyed by coingecko id
  private fail: Record<string, boolean>;

  constructor() {
    this.tokenPrices = {};
    this.fail = {};
  }

  price(input: CoinGeckoSimplePriceParams): CoinGeckoResponse {
    const data: SimplePriceResponse = {};
    for (const id of input.ids) {
      if (this.fail[id]) {
        return Promise.reject(`Failed to fetch price for ${id}`);
      }
      data[id] = {
        usd: this.tokenPrices[id],
      };
    }
    return Promise.resolve(data);
  }

  get simplePrice(): CoinGeckoSimplePriceInterface {
    return this.price;
  }

  setTokenPrice(chain: ChainName, price: number): void {
    this.tokenPrices[chain] = price;
  }

  setFail(chain: ChainName, fail: boolean): void {
    this.fail[chain] = fail;
  }
}
