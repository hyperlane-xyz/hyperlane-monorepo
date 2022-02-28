import { AgentConfig } from '../../../src/config/agent';
import * as dotenv from 'dotenv';

dotenv.config();
export const agentConfig: AgentConfig = {
  environment: 'production',
  namespace: 'optics-production-community',
  runEnv: 'mainnet',
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
    s3Bucket: 'optics-production-community-proofs',
    indexOnly: ['ethereum'],
  },
};
