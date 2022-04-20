// @ts-nocheck
import { AgentConfig } from '../../../src/config';
import { CheckpointSyncerType } from '../../../src/config/agent';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';

export const agent: AgentConfig = {
  environment: ENVIRONMENTS_ENUM.Test,
  namespace: ENVIRONMENTS_ENUM.Test,
  runEnv: ENVIRONMENTS_ENUM.Test,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'bef1be950322fdffd510c92d690b03aca8a5e250',
  },
  validator: {
    interval: 5,
    reorgPeriod: 0,
    checkpointSyncer: {
      type: CheckpointSyncerType.LocalStorage,
      path: '/tmp/local',
    },
    // confirmations: 1,
  },
  relayer: {
    multisigCheckpointSyncer: {
      threshold: 1,
      checkpointSyncers: {
        '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': {
          type: CheckpointSyncerType.LocalStorage,
          path: '/tmp/local',
        },
      },
    },
    pollingInterval: 5,
    submissionLatency: 10,
    maxRetries: 10,
    relayerMessageProcessing: true,
  },
  checkpointer: {
    pollingInterval: 5,
    creationLatency: 10,
  },
};
