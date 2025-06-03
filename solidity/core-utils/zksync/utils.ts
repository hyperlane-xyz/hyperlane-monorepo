import { zkSyncContractArtifacts } from './artifacts.js';
import { ZKSyncArtifact } from './types.js';

/**
 * @dev Get a ZkSync artifact by its name.
 * @param name The name of the artifact to get.
 * @return The loaded ZKSyncArtifact or undefined if it cannot be found.
 */
export function getZKSyncArtifactByName(
  name: string,
): ZKSyncArtifact | undefined {
  return zkSyncContractArtifacts.find(
    (artifact) => artifact.contractName === name,
  );
}

/**
 * @dev Loads all ZkSync artifacts into an array.
 * @return An array of ZkSync artifacts.
 */
export function loadAllZKSyncArtifacts(): ZKSyncArtifact[] {
  return zkSyncContractArtifacts;
}
