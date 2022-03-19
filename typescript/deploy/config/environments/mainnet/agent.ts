import { AgentConfig, DeployEnvironment } from '../../../src/config';

export const agentConfig: AgentConfig = {
  environment: DeployEnvironment.production,
  namespace: 'optics-production-community',
  runEnv: 'mainnet',
  aws: {
    region: 'us-west-2',
  },
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: 'e3c1b3bdcc8f92d506626785e4e7c058ba8d79be',
  },
  processor: {
    s3Bucket: 'optics-production-community-proofs',
    indexOnly: ['ethereum'],
  },
};
