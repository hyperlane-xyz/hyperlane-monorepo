import { CoreEnvironmentConfig } from '../../../src/config';
import { configs } from '../../networks/testnets';
import { core } from './core';
import { governance } from './governance';
import { agent } from './agent';
import { metrics } from './metrics';
import { infra } from './infra';

export const environment: CoreEnvironmentConfig = {
  domains: ['alfajores', 'kovan', 'mumbai', 'fuji'],
  transactionConfigs: configs,
  agent,
  core,
  governance,
  metrics,
  infra,
};
