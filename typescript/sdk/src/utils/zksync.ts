import { zksyncArtifacts } from '@hyperlane-xyz/core/artifacts';

export interface ZkSyncArtifact {
  contractName: string;
  sourceName: string;
  abi: any;
  bytecode: string;
  deployedBytecode: string;
  factoryDeps?: Record<string, string>;
}

export const getArtifactByContractName = (name: string): ZkSyncArtifact => {
  const artifact = (zksyncArtifacts as ZkSyncArtifact[]).find(
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
