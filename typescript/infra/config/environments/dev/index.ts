import { CoreEnvironmentConfig } from '../../../src/config';
import { configs } from '../../networks/testnets';

import { agent } from './agent';
import { core } from './core';
import { getMultiProvider } from './domains';
import { governance } from './governance';
import { infrastructure } from './infrastructure';
import { metrics } from './metrics';

const coreConfig = {
  alfajores: configs.alfajores,
  kovan: configs.kovan,
};

type corenet = keyof typeof coreConfig;

export const environment: CoreEnvironmentConfig<corenet> = {
  transactionConfigs: coreConfig,
  agent,
  core,
  governance,
  metrics,
  infra: infrastructure,
  getMultiProvider,
};
