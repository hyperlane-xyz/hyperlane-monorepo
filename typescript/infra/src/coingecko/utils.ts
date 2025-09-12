import { Logger } from 'pino';

import { DeployEnvironment } from '../config/environment.js';
import { fetchGCPSecret } from '../utils/gcloud.js';

export async function getCoinGeckoApiKey(
  logger: Logger,
): Promise<string | undefined> {
  const environment: DeployEnvironment = 'mainnet3';
  let apiKey: string | undefined;
  try {
    apiKey = (await fetchGCPSecret(
      `${environment}-coingecko-api-key`,
      false,
    )) as string;
  } catch (err) {
    logger.error(
      err,
      'Failed to fetch CoinGecko API key, proceeding with public tier',
    );
  }

  return apiKey;
}
