import { join } from 'path';

import { Contexts } from '../config/contexts.js';

import { getInfraPath } from './utils/utils.js';

export function getEnvironmentDirectory(environment: string) {
  return join('./config/environments/', environment);
}

export function getAWValidatorsPath(environment: string, context: Contexts) {
  return join(
    getInfraPath(),
    getEnvironmentDirectory(environment),
    'aw-validators',
    `${context}.json`,
  );
}
