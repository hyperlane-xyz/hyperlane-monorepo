import {
  ZkSyncArtifact,
  loadAllZkArtifacts,
} from '@hyperlane-xyz/core/zksync-artifacts';

/**
 * @dev Retrieves a ZkSync artifact by its contract name or qualified name.
 * @param name The name of the contract or qualified name in the format "sourceName:contractName".
 * @return The corresponding ZkSyncArtifact if found, or undefined if not found.
 */
export const getZKArtifactByContractName = async (
  name: string,
): Promise<ZkSyncArtifact | undefined> => {
  // Load all ZkSync artifacts
  const allArtifacts = await loadAllZkArtifacts();

  // Find the artifact that matches the contract name or qualified name
  const artifact = Object.values(allArtifacts).find(
    ({ contractName, sourceName }) => {
      const lowerCaseContractName = contractName.toLowerCase();
      const lowerCaseName = name.toLowerCase();

      // Check if the contract name matches
      if (lowerCaseContractName === lowerCaseName) {
        return true;
      }

      // Check if the qualified name matches
      const qualifiedName = `${sourceName}:${contractName}`;
      return qualifiedName === name; // Return true if qualified name matches
    },
  );

  return artifact;
};
