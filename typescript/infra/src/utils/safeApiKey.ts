import { assert } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from './gcloud.js';

const safeApiKeySecretName = 'gnosis-safe-api-key';

let safeApiKey: Promise<string> | undefined;

export async function getSafeApiKey(): Promise<string> {
  safeApiKey ??= fetchGCPSecret(safeApiKeySecretName, false)
    .then((secret) => {
      assert(
        typeof secret === 'string',
        'Safe API key secret must be a string',
      );
      return secret;
    })
    .catch((error) => {
      safeApiKey = undefined;
      throw error;
    });
  return safeApiKey;
}
