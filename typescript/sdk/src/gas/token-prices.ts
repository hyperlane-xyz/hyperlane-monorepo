import { objKeys, rootLogger, sleep } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../types.js';

const COINGECKO_PRICE_API = 'https://api.coingecko.com/api/v3/simple/price';

export interface TokenPriceGetter {
  getTokenPrice(chain: ChainName): Promise<number>;
  getTokenExchangeRate(base: ChainName, quote: ChainName): Promise<number>;
}

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
  protected cache: TokenPriceCache;
  protected apiKey?: string;
  protected sleepMsBetweenRequests: number;
  protected metadata: ChainMap<ChainMetadata>;

  constructor({
    chainMetadata,
    apiKey,
    expirySeconds,
    sleepMsBetweenRequests = 5000,
  }: {
    chainMetadata: ChainMap<ChainMetadata>;
    apiKey?: string;
    expirySeconds?: number;
    sleepMsBetweenRequests?: number;
  }) {
    this.apiKey = apiKey;
    this.cache = new TokenPriceCache(expirySeconds);
    this.metadata = chainMetadata;
    this.sleepMsBetweenRequests = sleepMsBetweenRequests;
  }

  async getTokenPrice(
    chain: ChainName,
    currency: string = 'usd',
  ): Promise<number> {
    const [price] = await this.getTokenPrices([chain], currency);
    return price;
  }

  async getAllTokenPrices(currency: string = 'usd'): Promise<ChainMap<number>> {
    const chains = objKeys(this.metadata);
    const prices = await this.getTokenPrices(chains, currency);
    return chains.reduce(
      (agg, chain, i) => ({ ...agg, [chain]: prices[i] }),
      {},
    );
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
      try {
        const prices = await this.fetchPriceData(toQuery, currency);
        prices.forEach((price, i) => this.cache.put(toQuery[i], price));
      } catch (err) {
        rootLogger.warn(err, 'Failed to fetch token prices');
        return undefined;
      }
    }
    return ids.map((id) => this.cache.fetch(id));
  }

  public async fetchPriceData(
    ids: string[],
    currency: string,
  ): Promise<number[]> {
    const tokenIds = ids.join(',');
    let url = `${COINGECKO_PRICE_API}?ids=${tokenIds}&vs_currencies=${currency}`;
    if (this.apiKey) {
      url += `&x-cg-pro-api-key=${this.apiKey}`;
    }

    const resp = await fetch(url);
    let idPrices: any = {};
    let jsonError: unknown;
    try {
      idPrices = await resp.json();
    } catch (err) {
      jsonError = err;
      idPrices = {};
    }

    if (!resp.ok) {
      rootLogger.warn(
        {
          status: resp.status,
          statusText: resp.statusText,
          url,
        },
        `Failed to fetch token prices: ${idPrices?.error}`,
      );
    }
    if (jsonError) {
      rootLogger.warn(jsonError, 'Failed to parse token prices');
    }

    return ids.map((id) => {
      const price = idPrices[id]?.[currency];
      if (!price) throw new Error(`No price found for ${id}`);
      return Number(price);
    });
  }
}
