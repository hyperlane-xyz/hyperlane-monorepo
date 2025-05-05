import {
  ChainMap,
  ChainMetadata,
  CoinGeckoTokenPriceGetter,
  Token,
} from '@hyperlane-xyz/sdk';

import { logger } from './infra/scripts/warp-routes/monitor/utils.js';

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
    const apiKey = PriceGetter.getCoinGeckoApiKey();

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

  static getCoinGeckoApiKey(): string | undefined {
    const environment = 'mainnet3';
    let apiKey: string | undefined;
    try {
      apiKey = tryGCPSecretFromEnvVariable(`${environment}-coingecko-api-key`);
    } catch (e) {
      logger.error(
        'Error fetching CoinGecko API key, proceeding with public tier',
        e,
      );
    }

    return apiKey;
  }
}

// If the environment variable GCP_SECRET_OVERRIDES_ENABLED is `true`,
// this will attempt to find an environment variable of the form:
//  `GCP_SECRET_OVERRIDE_${gcpSecretName.replaceAll('-', '_').toUpperCase()}`
// If found, it's returned, otherwise, undefined is returned.
function tryGCPSecretFromEnvVariable(gcpSecretName: string) {
  const overridingEnabled =
    process.env.GCP_SECRET_OVERRIDES_ENABLED &&
    process.env.GCP_SECRET_OVERRIDES_ENABLED.length > 0;

  if (!overridingEnabled) {
    logger.debug('GCP secret overrides disabled');
    return undefined;
  }

  logger.debug('GCP secret overrides enabled');
  const overrideEnvVarName = `GCP_SECRET_OVERRIDE_${gcpSecretName
    .replaceAll('-', '_')
    .toUpperCase()}`;

  return process.env[overrideEnvVarName];
}
