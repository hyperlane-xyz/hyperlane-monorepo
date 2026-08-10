import {
  Address,
  assert,
  objKeys,
  rootLogger,
  sleep,
} from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { ChainMap, ChainName } from '../types.js';

const COINGECKO_PUBLIC_API_BASE = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_API_BASE = 'https://pro-api.coingecko.com/api/v3';

// The configured key is a paid (pro) key, which must be sent as this header
// against the pro host. Sending it as a query param returns 401, and sending it
// to the public host returns HTTP 400 (error 10010, "use the pro host").
const COINGECKO_PRO_API_KEY_HEADER = 'x-cg-pro-api-key';

// CoinGecko caps the number of ids per /simple/price call; batch large id lists
// into chunks so one query covers many tokens instead of one request per token.
// The pro tier comfortably accepts this many ids per call.
const COINGECKO_MAX_IDS_PER_REQUEST = 100;

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

    if (toQuery.length > 0) {
      // Only rate-limit when we actually hit the network; serving from cache
      // should not incur the inter-request delay.
      await sleep(this.sleepMsBetweenRequests);
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

  /**
   * Batch-fetches prices for many ids in a single pass and populates the cache.
   * Unlike {@link getTokenPriceByIds}, an id with no returned price is skipped
   * (not fatal), so one unknown token cannot drop the whole batch. Callers can
   * then read individual prices from the cache via {@link getCachedTokenPrice}.
   * Intended for a once-per-cycle warm-up that replaces per-token requests.
   */
  public async prefetchTokenPrices(
    ids: string[],
    currency: string = 'usd',
  ): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    for (let i = 0; i < uniqueIds.length; i += COINGECKO_MAX_IDS_PER_REQUEST) {
      const chunk = uniqueIds.slice(i, i + COINGECKO_MAX_IDS_PER_REQUEST);
      // Space out chunks to stay within CoinGecko's rate limits.
      if (i > 0) await sleep(this.sleepMsBetweenRequests);
      let idPrices: Record<string, Record<string, number>>;
      try {
        idPrices = await this.get(
          `${this.priceApiUrl}?ids=${chunk.join(',')}&vs_currencies=${currency}`,
        );
      } catch (err) {
        rootLogger.warn(err, 'Failed to prefetch token price batch');
        continue;
      }
      for (const id of chunk) {
        const price = idPrices?.[id]?.[currency];
        if (price == null) continue;
        this.cache.put(id, Number(price));
      }
    }
  }

  /**
   * Returns a fresh cached price for an id, or undefined if absent/stale. Does
   * not hit the network; pair with {@link prefetchTokenPrices}.
   */
  public getCachedTokenPrice(id: string): number | undefined {
    if (!this.cache.isFresh(id)) return undefined;
    return this.cache.fetch(id);
  }

  // A pro key is only honored against the dedicated pro host; the public host
  // rejects it. Fall back to the public host only when no key is configured.
  private get apiBaseUrl(): string {
    return this.apiKey ? COINGECKO_PRO_API_BASE : COINGECKO_PUBLIC_API_BASE;
  }

  private get priceApiUrl(): string {
    return `${this.apiBaseUrl}/simple/price`;
  }

  private get coinApiUrl(): string {
    return `${this.apiBaseUrl}/coins`;
  }

  public async fetchPriceDataByContractAddress(
    chain: ChainName,
    contractAddress: Address,
  ): Promise<number> {
    const tokenPrice = await this.get(
      `${this.coinApiUrl}/${chain}/contract/${contractAddress}`,
    );

    const price = tokenPrice?.market_data?.current_price?.usd;
    assert(
      price,
      `USD price not found for token at address "${contractAddress}" and chain ${chain}`,
    );

    return price;
  }

  public async fetchPriceData(
    ids: string[],
    currency: string,
  ): Promise<number[]> {
    const tokenIds = ids.join(',');
    const idPrices = await this.get(
      `${this.priceApiUrl}?ids=${tokenIds}&vs_currencies=${currency}`,
    );

    return ids.map((id) => {
      const price = idPrices[id]?.[currency];
      if (!price) throw new Error(`No price found for ${id}`);
      return Number(price);
    });
  }

  private async get(endpoint: string): Promise<any> {
    const url = new URL(endpoint);
    // Send the key as a header, not a query param: the query-param form returns
    // 401, and the header also keeps the secret out of the URL (which is logged
    // on error below).
    const headers: Record<string, string> = this.apiKey
      ? { [COINGECKO_PRO_API_KEY_HEADER]: this.apiKey }
      : {};

    const resp = await fetch(url, { headers });
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

    return idPrices;
  }
}
