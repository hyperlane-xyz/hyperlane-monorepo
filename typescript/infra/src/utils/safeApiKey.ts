import { assert } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from './gcloud.js';

const safeApiKeySecretName = 'gnosis-safe-api-key';

let safeApiKey: string | undefined;

export async function getSafeApiKey(): Promise<string> {
  if (safeApiKey !== undefined) return safeApiKey;
  const secret = await fetchGCPSecret(safeApiKeySecretName, false);
  assert(typeof secret === 'string', 'Safe API key secret must be a string');
  safeApiKey = secret;
  return safeApiKey;
}
