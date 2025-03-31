import { readdirSync } from 'fs';
import path, { join } from 'path';
import { fileURLToPath } from 'url';

/**
 * @dev Represents a ZkSync artifact.
 */
export type ZkSyncArtifact = {
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
  [key: string]: ZkSyncArtifact; // Key is the artifact name, value is the ZkSyncArtifact
};

// Get the resolved path to the current file
const currentFilePath = fileURLToPath(import.meta.url); // Convert the module URL to a file path
const currentDirectory = path.dirname(currentFilePath);

/**
 * @dev Reads artifact files from the specified directory.
 * @param directory The directory to read artifact files from.
 * @return An array of artifact file names that end with '.js'.
 */
const getArtifactFiles = (directory: string): string[] => {
  return readdirSync(directory).filter((file) => file.endsWith('.js')); // Filter for .js files
};

/**
 * @dev Exports the list of artifact names without the .js extension.
 * @return An array of artifact names without the .js extension.
 */
export const zksyncArtifactNames = getArtifactFiles(
  join(currentDirectory, 'output'),
).map((file) => file.replace('.js', ''));

/**
 * @dev Checks if a ZkSync artifact exists by its name.
 * @param name The name of the artifact to check.
 * @return True if the artifact exists, false otherwise.
 */
export const artifactExists = (name: string): boolean => {
  return zksyncArtifactNames.includes(`${name}.js`); // Check if the artifact file exists
};

/**
 * @dev Loads a ZkSync artifact by its name.
 * @param name The name of the artifact to load.
 * @return The loaded ZkSyncArtifact or undefined if it cannot be loaded.
 */
const loadZkArtifact = async (
  name: string,
): Promise<ZkSyncArtifact | undefined> => {
  try {
    const artifactModule = await import(
      join(currentDirectory, 'output', `${name}.js`)
    ); // Dynamically import the artifact module
    return artifactModule[name]; // Return the artifact from the artifactModule
  } catch (error) {
    console.error(`Error loading artifact: ${name}`, error);
    return undefined;
  }
};

/**
 * @dev Loads all ZkSync artifacts into a map.
 * @return A map of artifact names to their corresponding ZkSync artifacts.
 */
export const loadAllZkArtifacts = async (): Promise<ArtifactMap> => {
  const zkSyncArtifactMap: ArtifactMap = {};

  // Load all artifacts concurrently
  const loadPromises = zksyncArtifactNames.map(async (artifactFileName) => {
    const artifact = await loadZkArtifact(artifactFileName);
    if (artifact) {
      zkSyncArtifactMap[artifactFileName] = artifact;
    }
  });

  await Promise.all(loadPromises);

  return zkSyncArtifactMap; // Return the populated artifact map
};

/**
 * @dev Retrieves a specific ZkSync artifact by its file name.
 * @param name The name of the artifact to retrieve.
 * @return The loaded ZkSyncArtifact or undefined if it cannot be loaded.
 */
export const getZkArtifactByName = async (
  name: string,
): Promise<ZkSyncArtifact | undefined> => {
  return loadZkArtifact(name);
};
