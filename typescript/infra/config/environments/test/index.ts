import { CoreEnvironmentConfig } from '../../../src/config';
import { configs } from '../../networks/testnets';
import { core } from './core';
import { governance } from './governance';
import { agent } from './agent';

export const environment: CoreEnvironmentConfig = {
  domains: ['alfajores', 'kovan', 'mumbai', 'fuji'],
  transactionConfigs: configs,
  agent,
  core,
  governance
};
