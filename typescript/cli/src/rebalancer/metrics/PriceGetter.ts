import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  Token,
} from '@hyperlane-xyz/sdk';

import { logger } from './utils.js';

export class PriceGetter extends CoinGeckoTokenPriceGetter {
  private constructor({
    chainMetadata,
    apiKey,
    expirySeconds,
    sleepMsBetweenRequests,
  }: {
    chainMetadata: ChainMap<ChainMetadata>;
    apiKey?: string;
    expirySeconds?: number;
    sleepMsBetweenRequests?: number;
  }) {
    super({ chainMetadata, apiKey, expirySeconds, sleepMsBetweenRequests });
  }

  public static async create(chainMetadata: ChainMap<ChainMetadata>) {
    const apiKey = await PriceGetter.getCoinGeckoApiKey();

    return new PriceGetter({ chainMetadata, apiKey });
  }

  // Tries to get the price of a token from CoinGecko. Returns undefined if there's no
  // CoinGecko ID for the token.
  async tryGetTokenPrice(token: Token): Promise<number | undefined> {
    // We only get a price if the token defines a CoinGecko ID.
    // This way we can ignore values of certain types of collateralized warp routes,
    // e.g. Native warp routes on rollups that have been pre-funded.
    const coinGeckoId = token.coinGeckoId;

    if (!coinGeckoId) {
      logger.warn('CoinGecko ID missing for token', token.symbol);
      return undefined;
    }

    return this.getCoingeckoPrice(coinGeckoId);
  }

  async getCoingeckoPrice(coingeckoId: string): Promise<number | undefined> {
    const prices = await this.getTokenPriceByIds([coingeckoId]);
    if (!prices) return undefined;
    return prices[0];
  }

  static async getCoinGeckoApiKey(): Promise<string | undefined> {
    // TODO: migrate/replicate gCloud from infra
    // const environment = 'mainnet3';
    let apiKey: string | undefined;
    try {
      // apiKey = (await fetchGCPSecret(
      //   `${environment}-coingecko-api-key`,
      //   false,
      // )) as string;
    } catch (e) {
      logger.error(
        'Error fetching CoinGecko API key, proceeding with public tier',
        e,
      );
    }

    return apiKey;
  }
}
