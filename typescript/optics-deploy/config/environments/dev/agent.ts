import { AgentConfig } from '../../../src/config/agent';

export const agentConfig: AgentConfig = {
  environment: 'dev',
  namespace: 'optics-dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: 'dev-2021-12-20',
  },
};
