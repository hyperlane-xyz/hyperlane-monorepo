import { AgentConfig } from '../../../src/config';
import { CheckpointSyncerType } from '../../../src/config/agent';

export const agent: AgentConfig = {
  environment: 'test',
  namespace: 'abacus-test',
  runEnv: 'test',
  docker: {
    repo: 'gcr.io/abacus-labs/abacus-agent',
    tag: 'e3c1b3bdcc8f92d506626785e4e7c058ba8d79be',
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
