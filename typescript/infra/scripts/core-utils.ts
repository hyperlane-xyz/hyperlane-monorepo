import { Contexts } from '../config/contexts.js';
import { environments } from '../config/environments/index.js';
import { DeployEnvironment } from '../src/config/environment.js';

import { getAgentConfig, getArgs, withContext } from './agent-utils.js';

// utils which use both environment configs

export function getEnvironmentConfig(environment: DeployEnvironment) {
  return environments[environment];
}

export async function getConfigsBasedOnArgs(argv?: {
  environment: DeployEnvironment;
  context: Contexts;
}) {
  const { environment, context = Contexts.Hyperlane } = argv
    ? argv
    : await withContext(getArgs()).argv;
  const envConfig = getEnvironmentConfig(environment);
  const agentConfig = getAgentConfig(context, environment);
  return { envConfig, agentConfig, context, environment };
}
