import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { TollkeeperHelmManager } from '../../src/tollkeeper/helm.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// ── Single source of truth for managed chains and routes ──
// These flow through: deploy script → HelmManager → helm values → env vars
// The tollkeeper service reads TOLLKEEPER_MANAGED_CHAINS and TOLLKEEPER_ROUTES
// at startup to override what's in system.yaml.

const MANAGED_CHAINS = [
  'ethereum',
  'arbitrum',
  'optimism',
  'base',
  'polygon',
  'bsc',
  'avalanche',
  'eclipsemainnet',
];

const ROUTES = ['USDC/eclipsemainnet'];

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { environment } = await getArgs().parse();

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  rootLogger.info({
    msg: 'Deploying Tollkeeper',
    environment,
    chains: MANAGED_CHAINS.length,
    routes: ROUTES.length,
  });

  const helmManager = new TollkeeperHelmManager(
    environment,
    MANAGED_CHAINS,
    ROUTES,
  );

  await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);

  rootLogger.info('Tollkeeper deploy complete');
}

main().catch((err) => {
  rootLogger.error(err);
  process.exit(1);
});
