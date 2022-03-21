import { AbacusGovernance, ChainName } from '@abacus-network/sdk';
import { GovernanceRouter } from '@abacus-network/apps';
import config from '../config';

export async function monitorGovernance(
  governance: AbacusGovernance,
  networks: ChainName[],
) {
  const routers = networks.map(
    (network) => governance.mustGetContracts(network).router,
  );
  await Promise.all(
    networks.map((network, i) => monitorRecoveryActiveAt(network, routers[i])),
  );
}

async function monitorRecoveryActiveAt(
  network: ChainName,
  router: GovernanceRouter,
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
