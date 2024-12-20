import { readFileSync, readdirSync } from 'fs';
import path, { join } from 'path';
import { fileURLToPath } from 'url';

/**
 * @dev Represents a ZkSync artifact.
 */
export type ZKSyncArtifact = {
  contractName: string;
  sourceName: string;
  abi: any;
  bytecode: string;
  deployedBytecode: string;
  factoryDeps?: Record<string, string>;
};

/**
 * @dev A mapping of artifact names to their corresponding ZkSync artifacts.
 */
export type ArtifactMap = {
  [key: string]: ZKSyncArtifact;
};

// Get the resolved path to the current file
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);

/**
 * @dev Reads artifact files from the specified directory.
 * @param directory The directory to read artifact files from.
 * @return An array of artifact file names that end with '.json'.
 */
function getArtifactFiles(directory: string): string[] {
  return readdirSync(directory).filter((file) => file.endsWith('.json'));
}

/**
 * @dev Exports the list of artifact names without the .json extension.
 * @return An array of artifact names without the .json extension.
 */
export const zksyncArtifactNames = getArtifactFiles(
  join(currentDirectory, 'artifacts'),
).map((file) => file.replace('.json', ''));

/**
 * @dev Checks if a ZkSync artifact exists by its name.
 * @param name The name of the artifact to check.
 * @return True if the artifact exists, false otherwise.
 */
export function artifactExists(name: string): boolean {
  return zksyncArtifactNames.includes(name);
}

/**
 * @dev Loads a ZkSync artifact by its name.
 * @param name The name of the artifact to load.
 * @return The loaded ZKSyncArtifact or undefined if it cannot be loaded.
 */
export function loadZKSyncArtifact(name: string): ZKSyncArtifact | undefined {
  try {
    const artifactPath = join(currentDirectory, 'artifacts', `${name}.json`);
    const artifactContent = readFileSync(artifactPath, 'utf-8');
    return JSON.parse(artifactContent) as ZKSyncArtifact;
  } catch (error) {
    console.error(`Error loading artifact: ${name}`, error);
    return undefined;
  }
}

/**
 * @dev Loads all ZkSync artifacts into a map.
 * @return A map of artifact names to their corresponding ZkSync artifacts.
 */
export function loadAllZKSyncArtifacts(): ArtifactMap {
  const zkSyncArtifactMap: ArtifactMap = {};

  for (const artifactName of zksyncArtifactNames) {
    const artifact = loadZKSyncArtifact(artifactName);
    if (artifact) {
      zkSyncArtifactMap[artifactName] = artifact;
    }
  }

  return zkSyncArtifactMap;
}

/**
 * @dev Retrieves a specific ZkSync artifact by its file name.
 * @param name The name of the artifact to retrieve.
 * @return The loaded ZkSyncArtifact or undefined if it cannot be loaded.
 */
export function getZKSyncArtifactByName(
  name: string,
): ZKSyncArtifact | undefined {
  return loadZKSyncArtifact(name);
}
