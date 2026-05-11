import { BuildArtifact, ChainMap } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { fetchGCPSecret } from '../utils/gcloud.js';

let explorerApiKeys: ChainMap<string> | undefined;

function isStringChainMap(value: unknown): value is ChainMap<string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

// read build artifact from given path
export function extractBuildArtifact(buildArtifactPath: string): BuildArtifact {
  // check provided artifact is JSON
  if (!buildArtifactPath.endsWith('.json')) {
    throw new Error('Source must be a JSON file.');
  }

  // return as BuildArtifact
  return readJson<BuildArtifact>(buildArtifactPath);
}

// fetch explorer API keys from GCP
export async function fetchExplorerApiKeys(): Promise<ChainMap<string>> {
  if (explorerApiKeys !== undefined) return explorerApiKeys;
  const secret = await fetchGCPSecret('explorer-api-keys', true);
  assert(
    isStringChainMap(secret),
    'explorer-api-keys secret must be a ChainMap<string>',
  );
  explorerApiKeys = secret;
  return explorerApiKeys;
}
