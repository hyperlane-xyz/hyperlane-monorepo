import {
  ZkSyncArtifact,
  loadAllZkArtifacts,
} from '@hyperlane-xyz/core/artifacts';

export const getZKArtifactByContractName = async (
  name: string,
): Promise<ZkSyncArtifact | undefined> => {
  const allArtifacts = await loadAllZkArtifacts();

  const artifact = (Object.values(allArtifacts) as ZkSyncArtifact[]).find(
    ({ contractName, sourceName }) => {
      if (contractName.toLowerCase() === name.toLowerCase()) {
        return true;
      }

      const qualifiedName = `${sourceName}:${contractName}`;
      if (name === qualifiedName) {
        return true;
      }

      return false;
    },
  );

  return artifact as any;
};
