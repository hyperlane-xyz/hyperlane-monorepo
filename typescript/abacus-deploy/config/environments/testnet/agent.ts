import { AgentConfig } from '../../../src/config/agent';
import * as dotenv from 'dotenv';

dotenv.config();
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
    tag: '0cd3c5e4e856f6eb77f04276eee411de5809e03c',
  },
  processor: {
    s3Bucket: 'optics-staging-community',
    indexOnly: ['kovan'],
  },
};
