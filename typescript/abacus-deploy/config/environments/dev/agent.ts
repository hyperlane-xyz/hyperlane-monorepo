import { AgentConfig } from '../../../src/config/agent';

export const agentConfig: AgentConfig = {
  environment: 'dev',
  namespace: 'optics-dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: '0cd3c5e4e856f6eb77f04276eee411de5809e03c',
  },
};
