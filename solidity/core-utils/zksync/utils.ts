import { zkSyncContractArtifacts } from './artifacts.js';
import { ZKSyncArtifact } from './types.js';

type ArtifactMap = Record<string, ZKSyncArtifact>;

/**
 * @dev Exports the list of artifact names.
 * @return An array of artifact names.
 */
export async function getZKSyncArtifactNames(): Promise<string[]> {
  return zkSyncContractArtifacts.map((artifact) => artifact.contractName);
}

/**
 * @dev Checks if a ZkSync artifact exists by its name.
 * @param name The name of the artifact to check.
 * @return True if the artifact exists, false otherwise.
 */
export async function artifactExists(name: string): Promise<boolean> {
  return zkSyncContractArtifacts.some(
    (artifact) => artifact.contractName === name,
  );
}

/**
 * @dev Loads a ZkSync artifact by its name.
 * @param name The name of the artifact to load.
 * @return The loaded ZKSyncArtifact or undefined if it cannot be found.
 */
export async function loadZKSyncArtifact(
  name: string,
): Promise<ZKSyncArtifact | undefined> {
  return zkSyncContractArtifacts.find(
    (artifact) => artifact.contractName === name,
  );
}

/**
 * @dev Loads all ZkSync artifacts into a map.
 * @return A map of artifact names to their corresponding ZkSync artifacts.
 */
export async function loadAllZKSyncArtifacts(): Promise<ArtifactMap> {
  return zkSyncContractArtifacts.reduce((map, artifact) => {
    map[artifact.contractName] = artifact;
    return map;
  }, {} as ArtifactMap);
}

/**
 * @dev Retrieves a specific ZkSync artifact by its name.
 * @param name The name of the artifact to retrieve.
 * @return The ZkSyncArtifact or undefined if it cannot be found.
 */
export async function getZKSyncArtifactByName(
  name: string,
): Promise<ZKSyncArtifact | undefined> {
  return loadZKSyncArtifact(name);
}
