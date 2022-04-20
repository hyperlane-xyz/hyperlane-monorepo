import { ChainName } from '@abacus-network/sdk';
import { AgentConfig } from '../../../src/config';
import { CheckpointSyncerType, ValidatorCheckpointSyncerConfigs } from '../../../src/config/agent';
import { ENVIRONMENTS_ENUM } from '../../../src/config/environment';

const localCheckpointSyncerPath = (chainName: ChainName, validatorAddress: string) =>
  `/local-checkpoint-syncers/${chainName}/${validatorAddress.toLowerCase()}`;

const validatorConfigs: {
  [chain in ChainName]?: ValidatorCheckpointSyncerConfigs
} = {
  alfajores: {
    '0x4455f6B4c341d48ef8CDBe1b9bE8bb3a63c97a46': {
      type: CheckpointSyncerType.LocalStorage,
      path: localCheckpointSyncerPath('alfajores', '0x4455f6B4c341d48ef8CDBe1b9bE8bb3a63c97a46'),
    },
    '0xD3f317f27D71b2A5fF9A1Ee78a1230390f77e714': {
      type: CheckpointSyncerType.LocalStorage,
      path: localCheckpointSyncerPath('alfajores', '0xD3f317f27D71b2A5fF9A1Ee78a1230390f77e714'),
    },
    '0x2C503aF4fe1BCb774E842BC0ACaAC5120dDFA560': {
      type: CheckpointSyncerType.LocalStorage,
      path: localCheckpointSyncerPath('alfajores', '0x2C503aF4fe1BCb774E842BC0ACaAC5120dDFA560'),
    }
  },
  kovan: {
    '0x16975a2f4c8354A6aeE0ef539b1BfDC8Ff69bD49': {
      type: CheckpointSyncerType.LocalStorage,
      path: localCheckpointSyncerPath('kovan', '0x16975a2f4c8354A6aeE0ef539b1BfDC8Ff69bD49'),
    },
    '0x5f7C587cA4be989a05dd37CCF02D29c71B98F1A9': {
      type: CheckpointSyncerType.LocalStorage,
      path: localCheckpointSyncerPath('kovan', '0x5f7C587cA4be989a05dd37CCF02D29c71B98F1A9'),
    },
    '0xF9d936b2Be7b1800E2B99cd8634c15a8A682fCE3': {
      type: CheckpointSyncerType.LocalStorage,
      path: localCheckpointSyncerPath('kovan', '0xF9d936b2Be7b1800E2B99cd8634c15a8A682fCE3'),
    },
  },
};

export const agent: AgentConfig = {
  environment: ENVIRONMENTS_ENUM.Dev,
  namespace: ENVIRONMENTS_ENUM.Dev,
  runEnv: ENVIRONMENTS_ENUM.Dev,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  validators: {
    common: {
      interval: 5,
      reorgPeriod: 1,
    },
    validators: validatorConfigs,
  },
  relayer: {
    multisigCheckpointSyncers: {
      alfajores: {
        threshold: 3,
        checkpointSyncers: validatorConfigs.alfajores!,
      },
      kovan: {
        threshold: 3,
        checkpointSyncers: validatorConfigs.kovan!,
      },
      
      // checkpointSyncers: 
      
      // {
        // '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': {
        //   type: CheckpointSyncerType.LocalStorage,
        //   path: '/tmp/local',
        // },
      // },
    },
    common: {
      pollingInterval: 5,
      submissionLatency: 10,
      maxRetries: 10,
      relayerMessageProcessing: true,
    }
  },
  checkpointer: {
    pollingInterval: 5,
    creationLatency: 10,
  },
};
