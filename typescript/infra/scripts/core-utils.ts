import { Contexts } from '../config/contexts';
import { environments } from '../config/environments';
import { DeployEnvironment } from '../src/config';

import { getAgentConfig, getArgs, withContext } from './agent-utils';

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
