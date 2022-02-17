import { OpticsContext } from '@abacus-network/sdk';
import config from '../config';

export async function monitorGovernor(context: OpticsContext) {
  await monitorGovernanceRouter(context, await context.governorDomain());
}

async function monitorGovernanceRouter(context: OpticsContext, domain: number) {
  const network = context.mustGetDomain(domain).name;
  const logger = config.baseLogger.child({
    network,
  });
  logger.info('Getting GovernanceRouter recoveryActiveAt');

  const governanceRouter = context.mustGetCore(domain).governanceRouter;
  const recoveryActiveAt = (
    await governanceRouter.recoveryActiveAt()
  ).toNumber();

  config.metrics.setGovernorRecoveryActiveAt(
    network,
    config.environment,
    recoveryActiveAt,
  );
}
