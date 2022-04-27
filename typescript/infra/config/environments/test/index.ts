import { CoreEnvironmentConfig } from '../../../src/config';
import { configs } from '../../networks/testnets';
import { agent } from './agent';
import { core } from './core';
import { governance } from './governance';
import { infra } from './infra';
import { metrics } from './metrics';

const coreConfig = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
  mumbai: configs.mumbai,
  fuji: configs.fuji,
};

type corenet = keyof typeof coreConfig;

// TODO: fix type inference
export const environment: CoreEnvironmentConfig<corenet> = {
  transactionConfigs: coreConfig,
  agent,
  core,
  governance,
  metrics,
  infra,
};
