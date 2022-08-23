import { ALL_KEY_ROLES } from '../../../src/agents/roles';
import { AgentConfig } from '../../../src/config';
import { Contexts } from '../../contexts';

import { TestChains, chainNames } from './chains';
import { validators } from './validators';

export const abacus: AgentConfig<TestChains> = {
  environment: 'test',
  namespace: 'test',
  runEnv: 'test',
  context: Contexts.Abacus,
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-agent',
    tag: '8852db3d88e87549269487da6da4ea5d67fdbfed',
  },
  environmentChainNames: chainNames,
  contextChainNames: chainNames,
  validatorSets: validators,
  validator: {
    default: {
      interval: 5,
      reorgPeriod: 0,
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
  [Contexts.Abacus]: abacus,
};
