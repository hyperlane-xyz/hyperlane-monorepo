import { AgentConfig } from '../../../src/config/agent';

// NB: environment and namespace are 'staging-community' for legacy
// reasons, it's annoying to change GCP to match a new naming convention.
export const agentConfig: AgentConfig = {
  environment: 'staging-community',
  namespace: 'optics-staging-community',
  runEnv: 'testnet',
  aws: {
    region: 'us-west-2',
  },
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: 'e3c1b3bdcc8f92d506626785e4e7c058ba8d79be',
  },
  processor: {
    s3Bucket: 'optics-staging-community',
    indexOnly: ['kovan'],
  },
};
