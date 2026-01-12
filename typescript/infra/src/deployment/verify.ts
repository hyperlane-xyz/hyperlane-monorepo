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

// fetch explorer API keys from GCP
export async function fetchExplorerApiKeys(): Promise<ChainMap<string>> {
  return fetchGCPSecret<ChainMap<string>>('explorer-api-keys', true);
}
