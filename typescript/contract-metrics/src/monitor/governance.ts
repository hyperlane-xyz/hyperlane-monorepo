import { AbacusContext } from '@abacus-network/sdk';
import { xapps } from '@abacus-network/ts-interface';
import config from '../config';

export async function monitorGovernance(
  context: AbacusContext,
  networks: string[],
) {
  const routers = networks.map(
    (network) => context.mustGetCore(network).governanceRouter,
  );
  await Promise.all(
    networks.map((network, i) => monitorRecoveryActiveAt(network, routers[i])),
  );
}

async function monitorRecoveryActiveAt(
  network: string,
  router: xapps.GovernanceRouter,
) {
  const logger = config.baseLogger.child({
    network,
  });
  logger.info('Getting GovernanceRouter recoveryActiveAt');

  const recoveryActiveAt = (await router.recoveryActiveAt()).toNumber();

  config.metrics.setGovernorRecoveryActiveAt(
    network,
    config.environment,
    recoveryActiveAt,
  );
}
