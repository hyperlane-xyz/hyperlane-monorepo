import type { ZKSyncArtifact } from './types.js';

// Default empty artifact array when `yarn build:zk` hasn't been run
// This file will be populated with contract artifacts in dist after running the build:zk command
export const zkSyncContractArtifacts: ZKSyncArtifact[] = [] as const;
