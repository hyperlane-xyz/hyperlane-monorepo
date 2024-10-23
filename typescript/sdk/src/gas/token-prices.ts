import CoinGecko from 'coingecko-api';

import { rootLogger, sleep } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../types.js';

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
  protected cache: Map<string, TokenPriceCacheEntry>;
  protected freshSeconds: number;
  protected evictionSeconds: number;

  constructor(freshSeconds = 60, evictionSeconds = 3 * 60 * 60) {
    this.cache = new Map<string, TokenPriceCacheEntry>();
    this.freshSeconds = freshSeconds;
    this.evictionSeconds = evictionSeconds;
  }

  put(id: string, price: number): void {
    const now = new Date();
    this.cache.set(id, { timestamp: now, price });
  }

  isFresh(id: string): boolean {
    const entry = this.cache.get(id);
    if (!entry) return false;

    const expiryTime = new Date(
      entry.timestamp.getTime() + 1000 * this.freshSeconds,
    );
    const now = new Date();
    return now < expiryTime;
  }

  fetch(id: string): number {
    const entry = this.cache.get(id);
    if (!entry) {
      throw new Error(`no entry found for ${id} in token price cache`);
    }
    const evictionTime = new Date(
      entry.timestamp.getTime() + 1000 * this.evictionSeconds,
    );
    const now = new Date();
    if (now > evictionTime) {
      throw new Error(`evicted entry found for ${id} in token price cache`);
    }
    return entry.price;
  }
}

export class CoinGeckoTokenPriceGetter implements TokenPriceGetter {
  protected coinGecko: CoinGeckoInterface;
  protected cache: TokenPriceCache;
  protected sleepMsBetweenRequests: number;
  protected metadata: ChainMap<ChainMetadata>;

  constructor(
    coinGecko: CoinGeckoInterface,
    chainMetadata: ChainMap<ChainMetadata>,
    expirySeconds?: number,
    sleepMsBetweenRequests = 5000,
  ) {
    this.coinGecko = coinGecko;
    this.cache = new TokenPriceCache(expirySeconds);
    this.metadata = chainMetadata;
    this.sleepMsBetweenRequests = sleepMsBetweenRequests;
  }

  static withDefaultCoinGecko(
    chainMetadata: ChainMap<ChainMetadata>,
    expirySeconds?: number,
    sleepMsBetweenRequests = 5000,
  ): CoinGeckoTokenPriceGetter {
    const coinGecko = new CoinGecko();
    return new CoinGeckoTokenPriceGetter(
      coinGecko,
      chainMetadata,
      expirySeconds,
      sleepMsBetweenRequests,
    );
  }

  async getTokenPrice(
    chain: ChainName,
    currency: string = 'usd',
  ): Promise<number> {
    const [price] = await this.getTokenPrices([chain], currency);
    return price;
  }

  async getTokenExchangeRate(
    base: ChainName,
    quote: ChainName,
    currency: string = 'usd',
  ): Promise<number> {
    const [basePrice, quotePrice] = await this.getTokenPrices(
      [base, quote],
      currency,
    );
    return basePrice / quotePrice;
  }

  private async getTokenPrices(
    chains: ChainName[],
    currency: string = 'usd',
  ): Promise<number[]> {
    const isMainnet = chains.map((c) => !this.metadata[c].isTestnet);
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

    const ids = chains.map(
      (chain) => this.metadata[chain].gasCurrencyCoinGeckoId || chain,
    );

    await this.getTokenPriceByIds(ids, currency);
    return chains.map((chain) =>
      this.cache.fetch(this.metadata[chain].gasCurrencyCoinGeckoId || chain),
    );
  }

  public async getTokenPriceByIds(
    ids: string[],
    currency: string = 'usd',
  ): Promise<number[] | undefined> {
    const toQuery = ids.filter((id) => !this.cache.isFresh(id));
    await sleep(this.sleepMsBetweenRequests);

    if (toQuery.length > 0) {
      let response: any;
      try {
        response = await this.coinGecko.simple.price({
          ids: toQuery,
          vs_currencies: [currency],
        });

        if (response.success === true) {
          const prices = toQuery.map((id) => response.data[id][currency]);
          toQuery.map((id, i) => this.cache.put(id, prices[i]));
        } else {
          rootLogger.warn('Failed to query token prices', response.message);
          return undefined;
        }
      } catch (e) {
        rootLogger.warn('Error when querying token prices', e);
        return undefined;
      }
    }
    return ids.map((id) => this.cache.fetch(id));
  }
}
