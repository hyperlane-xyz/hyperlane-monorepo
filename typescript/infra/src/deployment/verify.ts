import { BuildArtifact, ChainMap } from '@hyperlane-xyz/sdk';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { fetchGCPSecret } from '../utils/gcloud.js';

// read build artifact from given path
export function extractBuildArtifact(buildArtifactPath: string): BuildArtifact {
  // check provided artifact is JSON
  if (!buildArtifactPath.endsWith('.json')) {
    throw new Error('Source must be a JSON file.');
  }

  // return as BuildArtifact
  return readJson<BuildArtifact>(buildArtifactPath);
}

function isChainMapOfStrings(value: unknown): value is ChainMap<string> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}

// fetch explorer API keys from GCP
export async function fetchExplorerApiKeys(): Promise<ChainMap<string>> {
  const secret = await fetchGCPSecret('explorer-api-keys', true);
  if (!isChainMapOfStrings(secret)) {
    throw new Error(
      'Invalid explorer-api-keys secret format, expected object of string values',
    );
  }
  return secret;
}
