import { promises as fsPromises } from 'fs';
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
async function getArtifactFiles(directory: string): Promise<string[]> {
  return fsPromises
    .readdir(directory)
    .then((files) => files.filter((file) => file.endsWith('.json')));
}

/**
 * @dev Exports the list of artifact names without the .json extension.
 * @return An array of artifact names without the .json extension.
 */
export async function getZKSyncArtifactNames(): Promise<string[]> {
  return getArtifactFiles(join(currentDirectory, 'artifacts')).then((files) =>
    files.map((file) => file.replace('.json', '')),
  );
}

/**
 * @dev Checks if a ZkSync artifact exists by its name.
 * @param name The name of the artifact to check.
 * @return True if the artifact exists, false otherwise.
 */
export async function artifactExists(name: string): Promise<boolean> {
  const artifactNames = await getZKSyncArtifactNames();
  return artifactNames.includes(name);
}

/**
 * @dev Loads a ZkSync artifact by its name.
 * @param name The name of the artifact to load.
 * @return The loaded ZKSyncArtifact or undefined if it cannot be loaded.
 */
export async function loadZKSyncArtifact(
  name: string,
): Promise<ZKSyncArtifact | undefined> {
  try {
    const artifactPath = join(currentDirectory, 'artifacts', `${name}.json`);
    const artifactContent = await fsPromises.readFile(artifactPath, 'utf-8');
    return JSON.parse(artifactContent);
  } catch (error) {
    console.error(`Error loading artifact: ${name}`, error);
    return undefined;
  }
}

/**
 * @dev Loads all ZkSync artifacts into a map.
 * @return A map of artifact names to their corresponding ZkSync artifacts.
 */
export async function loadAllZKSyncArtifacts(): Promise<ArtifactMap> {
  const zkSyncArtifactMap: ArtifactMap = {};
  const zksyncArtifactNames = await getZKSyncArtifactNames();
  for (const artifactName of zksyncArtifactNames) {
    const artifact = await loadZKSyncArtifact(artifactName);
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
export async function getZKSyncArtifactByName(
  name: string,
): Promise<ZKSyncArtifact | undefined> {
  return loadZKSyncArtifact(name);
}
