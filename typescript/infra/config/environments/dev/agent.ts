import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import { Contexts } from '../../contexts';

import { DevChains, chainNames } from './chains';
import { validators } from './validators';

export const abacus: AgentConfig<DevChains> = {
  environment: 'dev',
  namespace: 'dev',
  runEnv: 'dev',
  context: Contexts.Abacus,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: 'sha-5e639a2',
  },
  tracing: {
    level: 'debug',
    format: 'json',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 1,
    },
  },
  relayer: {
    default: {
      signedCheckpointPollingInterval: 5,
      maxProcessingRetries: 10,
    },
  },
  rolesWithKeys: ALL_KEY_ROLES,
};

export const agents = {
  abacus,
};
