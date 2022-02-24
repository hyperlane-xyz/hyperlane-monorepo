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
    tag: 'e3c1b3bdcc8f92d506626785e4e7c058ba8d79be',
  },
  processor: {
    s3Bucket: 'optics-production-community-proofs',
    indexOnly: ['ethereum'],
  },
};
