import { AgentConfig } from '../../../src/config/agents';

// NB: environment and namespace are 'staging-community' for legacy
// reasons, it's annoying to change GCP to match a new naming convention.
export const agentConfig: AgentConfig = {
  environment: 'staging-community',
  namespace: 'optics-staging-community',
  runEnv: 'testnet',
  awsRegion: process.env.AWS_REGION!,
  awsKeyId: process.env.AWS_KEY_ID!,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  dockerImageRepo: 'gcr.io/clabs-optics/optics-agent',
  dockerImageTag: '3594c7d715f0ad1def2b36cb0e29649e1f6712e6',
};
