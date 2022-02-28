import { AgentConfig } from '../../../src/config/agent';

export const agentConfig: AgentConfig = {
  environment: 'dev',
  namespace: 'optics-dev',
  runEnv: 'dev',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-agent',
    tag: 'c9ed58ad919340d5b838fbc9f9f1ed2763c53ed3',
  },
};
