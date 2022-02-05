import { AgentConfig } from '../../../src/config/agents';

export const agentConfig: AgentConfig = {
  environment: 'dev',
  namespace: 'optics-dev',
  runEnv: configDirectory,
  dockerImageRepo: 'gcr.io/clabs-optics/optics-agent',
  dockerImageTag: 'dev-2021-12-20',
};
