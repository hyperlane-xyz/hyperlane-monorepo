import { AgentConfig } from '../../../src/config';

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
    confirmations: 1,
  },
  relayer: {
    interval: 5,
  },
  checkpointer: {
    pollingInterval: 5,
    creationLatency: 10,
  },
};
