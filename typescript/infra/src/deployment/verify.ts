import { BuildArtifact, ChainMap } from '@hyperlane-xyz/sdk';

import { fetchGCPSecret } from '../utils/gcloud.js';
import { readJSONAtPath } from '../utils/utils.js';

// read build artifact from given path
export function extractBuildArtifact(buildArtifactPath: string): BuildArtifact {
  // check provided artifact is JSON
  if (!buildArtifactPath.endsWith('.json')) {
    throw new Error('Source must be a JSON file.');
  }

  // return as BuildArtifact
  return readJSONAtPath(buildArtifactPath) as BuildArtifact;
}

// fetch explorer API keys from GCP
export async function fetchExplorerApiKeys(): Promise<ChainMap<string>> {
  return (await fetchGCPSecret('explorer-api-keys', true)) as any;
}
