import { Logger } from 'pino';

import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  Token,
} from '@hyperlane-xyz/sdk';

export class PriceGetter extends CoinGeckoTokenPriceGetter {
  private readonly logger: Logger;

  private constructor({
    chainMetadata,
    logger,
    apiKey,
    expirySeconds,
    sleepMsBetweenRequests,
  }: {
    chainMetadata: ChainMap<ChainMetadata>;
    logger: Logger;
    apiKey?: string;
    expirySeconds?: number;
    sleepMsBetweenRequests?: number;
  }) {
    super({ chainMetadata, apiKey, expirySeconds, sleepMsBetweenRequests });
    this.logger = logger;
  }

  public static create(
    chainMetadata: ChainMap<ChainMetadata>,
    logger: Logger,
    coingeckoApiKey?: string,
    expirySeconds?: number,
    sleepMsBetweenRequests?: number,
  ) {
    return new PriceGetter({
      chainMetadata,
      logger,
      apiKey: coingeckoApiKey,
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
      this.logger.warn(
        {
          tokenSymbol: token.symbol,
          chain: token.chainName,
          tokenAddress: token.addressOrDenom,
        },
        'CoinGecko ID missing for token',
      );
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
