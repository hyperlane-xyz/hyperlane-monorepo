import { ChainMap } from '@hyperlane-xyz/sdk';

import { fetchGCPSecret } from '../utils/gcloud';
import { readJSONAtPath } from '../utils/utils';

// extract input json & compiler version from build artifact json
export function extractSource(buildArtifact: string): {
  source: string;
  compilerversion: string;
} {
  // check provided artifact is JSON
  const sourcePath = buildArtifact;
  if (!sourcePath.endsWith('.json')) {
    throw new Error('Source must be a JSON file.');
  }

  // parse build artifacts for std input json + solc version
  const buildArtifactJson = readJSONAtPath(sourcePath);
  const source = buildArtifactJson.input;
  const solcLongVersion = buildArtifactJson.solcLongVersion;
  const compilerversion = `v${solcLongVersion}`;

  // check solc version is in the right format
  const versionRegex = /v(\d.\d.\d+)\+commit.\w+/;
  const matches = versionRegex.exec(compilerversion);
  if (!matches) {
    throw new Error(`Invalid compiler version ${compilerversion}`);
  }

  return { source, compilerversion };
}

// fetch explorer API keys from GCP
export async function fetchExplorerApiKeys(): Promise<ChainMap<string>> {
  return (await fetchGCPSecret('explorer-api-keys', true)) as any;
}
