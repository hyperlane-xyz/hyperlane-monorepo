import { Contexts } from '../../config/contexts.js';
import { Role } from '../../src/roles.js';
import {
  getArgs,
  withBuildArtifactPath,
  withChains,
  withConcurrentDeploy,
  withContext,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

export async function getRouterConfig() {
  const {
    context = Contexts.Hyperlane,
    environment,
    chains,
  } = await withContext(
    withConcurrentDeploy(withChains(withBuildArtifactPath(getArgs()))),
  ).argv;
  const envConfig = getEnvironmentConfig(environment);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    chains,
  );
  const { core } = await getHyperlaneCore(environment, multiProvider);
  return core.getRouterConfig(envConfig.owners);
}
