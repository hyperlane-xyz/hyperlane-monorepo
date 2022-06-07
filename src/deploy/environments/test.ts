import { configs } from '../networks';
import { HelloWorldEnvironmentConfig } from './index';

export const environment: HelloWorldEnvironmentConfig = {
  ...configs,
  config: {},
};
