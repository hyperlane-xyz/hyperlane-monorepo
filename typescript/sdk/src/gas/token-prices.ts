import CoinGecko from 'coingecko-api';

import { chainMetadata } from '../consts/chainMetadata';
import { Mainnets } from '../consts/chains';
import { ChainName } from '../types';

export interface TokenPriceGetter {
  getTokenPrice(chain: ChainName): Promise<number>;
  getTokenExchangeRate(base: ChainName, quote: ChainName): Promise<number>;
}

export type CoinGeckoInterface = Pick<CoinGecko, 'simple'>;
export type CoinGeckoSimpleInterface = CoinGecko['simple'];
export type CoinGeckoSimplePriceParams = Parameters<
  CoinGeckoSimpleInterface['price']
>[0];
export type CoinGeckoResponse = ReturnType<CoinGeckoSimpleInterface['price']>;

type TokenPriceCacheEntry = {
  price: number;
  timestamp: Date;
};

class TokenPriceCache {
  protected cache: Map<ChainName, TokenPriceCacheEntry>;
  protected expirySeconds: number;

  constructor(expirySeconds = 3 * 60 * 60) {
    this.cache = new Map<ChainName, TokenPriceCacheEntry>();
    this.expirySeconds = expirySeconds;
  }

  put(chain: ChainName, price: number): void {
    const now = new Date();
    this.cache.set(chain, { timestamp: now, price });
  }

  fetch(chain: ChainName): number {
    const now = new Date();
    const entry = this.cache.get(chain);
    if (!entry) {
      throw new Error(`no entry found for ${chain} in token price cache`);
    }
    const expiry = new Date(
      entry.timestamp.getTime() + 1000 * this.expirySeconds,
    );
    if (now > expiry) {
      throw new Error(`expired entry found for ${chain} in token price cache`);
    }
    return entry.price;
  }
}

export class CoinGeckoTokenPriceGetter implements TokenPriceGetter {
  protected coinGecko: CoinGeckoInterface;
  protected cache: TokenPriceCache;

  constructor(coinGecko: CoinGeckoInterface, cacheExpirySeconds?: number) {
    this.coinGecko = coinGecko;
    this.cache = new TokenPriceCache(cacheExpirySeconds);
  }

  async getTokenPrice(chain: ChainName): Promise<number> {
    const [price] = await this.getTokenPrices([chain]);
    return price;
  }

  async getTokenExchangeRate(
    base: ChainName,
    quote: ChainName,
  ): Promise<number> {
    const [basePrice, quotePrice] = await this.getTokenPrices([base, quote]);
    return basePrice / quotePrice;
  }

  private async getTokenPrices(chains: ChainName[]): Promise<number[]> {
    const isMainnet = chains.map((c) => Mainnets.includes(c));
    const allMainnets = isMainnet.every((v) => v === true);
    const allTestnets = isMainnet.every((v) => v === false);
    if (allTestnets) {
      // Testnet tokens are all artificially priced at 1.0 USD.
      return chains.map(() => 1);
    }

    if (!allMainnets) {
      throw new Error(
        'Cannot mix testnets and mainnets when fetching token prices',
      );
    }

    const currency = 'usd';
    // The CoinGecko API expects, in some cases, IDs that do not match
    // ChainNames.
    const ids = chains.map(
      (chain) => chainMetadata[chain].gasCurrencyCoinGeckoId || chain,
    );
    try {
      const response = await this.coinGecko.simple.price({
        ids,
        vs_currencies: [currency],
      });
      const prices = ids.map((id) => response.data[id][currency]);
      // Update the cache with the newly fetched prices
      chains.map((chain, i) => this.cache.put(chain, prices[i]));
      return prices;
    } catch (e) {
      console.warn(
        `Unable to fetch prices for ${chains}, attempting to use cache: "${e}"`,
      );
      // Fall back to looking up prices in the cache.
      return chains.map((chain) => this.cache.fetch(chain));
    }
  }
}
