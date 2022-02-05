import { AgentConfig } from '../../../src/config/agents';

export const agentConfig: AgentConfig = {
  environment: 'production',
  namespace: 'optics-production-community',
  runEnv: configDirectory,
  awsRegion: process.env.AWS_REGION!,
  awsKeyId: process.env.AWS_KEY_ID!,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  dockerImageRepo: 'gcr.io/clabs-optics/optics-agent',
  dockerImageTag: '3594c7d715f0ad1def2b36cb0e29649e1f6712e6',
};
