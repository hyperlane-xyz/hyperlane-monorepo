import { CheckpointStorage__factory } from '@hyperlane-xyz/core';

export const checkpointStorageFactories = {
  checkpointStorage: new CheckpointStorage__factory(),
};

export type CheckpointStorageFactories = typeof checkpointStorageFactories;

export type DeployedCheckpointStorage = Awaited<
  ReturnType<InstanceType<typeof CheckpointStorage__factory>['deploy']>
>;
