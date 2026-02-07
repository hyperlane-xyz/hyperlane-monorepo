import { assert } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from './gcloud.js';

const safeApiKeySecretName = 'gnosis-safe-api-key';

export async function getSafeApiKey(): Promise<string> {
  const secret = await fetchGCPSecret(safeApiKeySecretName, false);
  assert(typeof secret === 'string', 'Safe API key secret must be a string');
  return secret;
}
