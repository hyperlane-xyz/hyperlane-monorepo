import { AgentConfig } from '../../../src/config/agent';

// NB: environment and namespace are 'staging-community' for legacy
// reasons, it's annoying to change GCP to match a new naming convention.
export const agentConfig: AgentConfig = {
  environment: 'staging-community',
  namespace: 'optics-staging-community',
  runEnv: 'testnet',
  aws: {
    region: process.env.AWS_REGION!,
    keyId: process.env.AWS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: '3594c7d715f0ad1def2b36cb0e29649e1f6712e6',
  }
};
