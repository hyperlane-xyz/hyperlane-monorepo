import yargs from 'yargs';

import { Contexts } from '../../config/contexts.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../src/warp/helm.js';
import {
  assertCorrectKubeContext,
  getAgentConfig,
  getArgs,
  withWarpRouteIdRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment, warpRouteId } = await withWarpRouteIdRequired(getArgs())
    .argv;

  await assertCorrectKubeContext(getEnvironmentConfig(environment));
  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);

  const helmManager = new WarpRouteMonitorHelmManager(
    warpRouteId,
    environment,
    agentConfig.environmentChainNames,
  );
  await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade, true);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
