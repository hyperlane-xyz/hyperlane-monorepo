import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  Token,
} from '@hyperlane-xyz/sdk';

import { warnYellow } from '../../logger.js';

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

  public static create(
    chainMetadata: ChainMap<ChainMetadata>,
    expirySeconds?: number,
    sleepMsBetweenRequests?: number,
  ) {
    const apiKey = process.env.COINGECKO_API_KEY;

    return new PriceGetter({
      chainMetadata,
      apiKey,
      expirySeconds,
      sleepMsBetweenRequests,
    });
  }

  // Tries to get the price of a token from CoinGecko. Returns undefined if there's no
  // CoinGecko ID for the token.
  async tryGetTokenPrice(token: Token): Promise<number | undefined> {
    // We only get a price if the token defines a CoinGecko ID.
    // This way we can ignore values of certain types of collateralized warp routes,
    // e.g. Native warp routes on rollups that have been pre-funded.
    const coinGeckoId = token.coinGeckoId;

    if (!coinGeckoId) {
      warnYellow('CoinGecko ID missing for token', token.symbol);
      return undefined;
    }

    return this.getCoingeckoPrice(coinGeckoId);
  }

  async getCoingeckoPrice(coingeckoId: string): Promise<number | undefined> {
    const prices = await this.getTokenPriceByIds([coingeckoId]);
    if (!prices) return undefined;
    return prices[0];
  }
}
