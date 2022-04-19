import { AgentConfig } from '../../../src/config';
import { CheckpointSyncerType } from '../../../src/config/agent';

export const agent: AgentConfig = {
  environment: 'test',
  namespace: 'test',
  runEnv: 'test',
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'e309bb2187f56a83bc8a2120da0f2c38bfce951d',
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
