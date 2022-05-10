import { configs } from '../networks';
import { HelloWorldConfig } from './index';

export const environment: HelloWorldConfig = {
  ...configs,
  config: {},
};
