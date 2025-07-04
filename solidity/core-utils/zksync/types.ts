export interface ZKSyncArtifact {
  _format: string;
  contractName: string;
  sourceName: string;
  abi: any[];
  bytecode: string;
  deployedBytecode: string;
  linkReferences: Record<string, any>;
  deployedLinkReferences: Record<string, any>;
  factoryDeps: Record<string, any>;
}
