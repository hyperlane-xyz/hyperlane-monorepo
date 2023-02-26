import CoinGecko from 'coingecko-api';

import { warn } from '@hyperlane-xyz/utils';

import {
  ChainMetadata,
  chainMetadata as defaultChainMetadata,
} from '../consts/chainMetadata';
import { CoreChainName, Mainnets } from '../consts/chains';
import { ChainMap, ChainName } from '../types';

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
  protected freshSeconds: number;
  protected evictionSeconds: number;

  constructor(freshSeconds = 60, evictionSeconds = 3 * 60 * 60) {
    this.cache = new Map<ChainName, TokenPriceCacheEntry>();
    this.freshSeconds = freshSeconds;
    this.evictionSeconds = evictionSeconds;
  }

  put(chain: ChainName, price: number): void {
    const now = new Date();
    this.cache.set(chain, { timestamp: now, price });
  }

  isFresh(chain: ChainName): boolean {
    const entry = this.cache.get(chain);
    if (!entry) return false;

    const expiryTime = new Date(
      entry.timestamp.getTime() + 1000 * this.freshSeconds,
    );
    const now = new Date();
    return now < expiryTime;
  }

  fetch(chain: ChainName): number {
    const entry = this.cache.get(chain);
    if (!entry) {
      throw new Error(`no entry found for ${chain} in token price cache`);
    }
    const evictionTime = new Date(
      entry.timestamp.getTime() + 1000 * this.evictionSeconds,
    );
    const now = new Date();
    if (now > evictionTime) {
      throw new Error(`evicted entry found for ${chain} in token price cache`);
    }
    return entry.price;
  }
}

export class CoinGeckoTokenPriceGetter implements TokenPriceGetter {
  protected coinGecko: CoinGeckoInterface;
  protected cache: TokenPriceCache;
  protected metadata: ChainMap<ChainMetadata>;

  constructor(
    coinGecko: CoinGeckoInterface,
    expirySeconds?: number,
    chainMetadata = defaultChainMetadata,
  ) {
    this.coinGecko = coinGecko;
    this.cache = new TokenPriceCache(expirySeconds);
    this.metadata = chainMetadata;
  }

  static new(expirySeconds?: number): CoinGeckoTokenPriceGetter {
    const coinGecko = new CoinGecko();
    return new CoinGeckoTokenPriceGetter(coinGecko, expirySeconds);
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
    // TODO improve PI support here?
    const isMainnet = chains.map((c) => Mainnets.includes(c as CoreChainName));
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

    const toQuery = chains.filter((c) => !this.cache.isFresh(c));
    if (toQuery.length > 0) {
      try {
        await this.queryTokenPrices(toQuery);
      } catch (e) {
        warn('Failed to query token prices', e);
      }
    }
    return chains.map((chain) => this.cache.fetch(chain));
  }

  private async queryTokenPrices(chains: ChainName[]): Promise<void> {
    const currency = 'usd';
    // The CoinGecko API expects, in some cases, IDs that do not match
    // ChainNames.
    const ids = chains.map(
      (chain) => this.metadata[chain].gasCurrencyCoinGeckoId || chain,
    );
    const response = await this.coinGecko.simple.price({
      ids,
      vs_currencies: [currency],
    });
    const prices = ids.map((id) => response.data[id][currency]);
    // Update the cache with the newly fetched prices
    chains.map((chain, i) => this.cache.put(chain, prices[i]));
  }
}
