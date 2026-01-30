import { fetchGCPSecret } from './gcloud.js';

const safeApiKeySecretName = 'gnosis-safe-api-key';

export async function getSafeApiKey(): Promise<string> {
  return (await fetchGCPSecret(safeApiKeySecretName, false)) as string;
}
