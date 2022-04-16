import { CoreEnvironmentConfig } from '../../../src/config';
import { configs } from '../../networks/testnets';
import { agent } from './agent';
import { core } from './core';
import { governance } from './governance';
import { infra } from './infra';
import { metrics } from './metrics';

// TODO: fix type inference
export const environment: CoreEnvironmentConfig<
  'alfajores' | 'kovan' | 'mumbai' | 'fuji'
> = {
  domains: ['alfajores', 'kovan', 'mumbai', 'fuji'],
  transactionConfigs: configs,
  agent,
  core,
  governance,
  metrics,
  infra,
};
