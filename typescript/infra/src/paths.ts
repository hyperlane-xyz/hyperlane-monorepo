import { join } from 'path';

import { Contexts } from '../config/contexts.js';

import type { DeployEnvironment } from './config/environment.js';
import { getInfraPath } from './utils/utils.js';

export function getEnvironmentDirectory(environment: DeployEnvironment) {
  return join('./config/environments/', environment);
}

export function getAWValidatorsPath(
  environment: DeployEnvironment,
  context: Contexts,
) {
  return join(
    getInfraPath(),
    getEnvironmentDirectory(environment),
    'aw-validators',
    `${context}.json`,
  );
}
