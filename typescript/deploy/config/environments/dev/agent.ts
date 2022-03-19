import { AgentConfig, DeployEnvironment } from '../../../src/config';

export const agentConfig: AgentConfig = {
  environment: DeployEnvironment.dev,
  namespace: 'optics-dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: 'e3c1b3bdcc8f92d506626785e4e7c058ba8d79be',
  },
};
