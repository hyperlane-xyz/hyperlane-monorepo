import { OpticsContext } from '@abacus-network/sdk';
import { getEvents } from '@abacus-network/sdk/dist/optics/events/fetch';
import Logger from 'bunyan';
import { logMonitorMetrics, writeUnprocessedMessages } from '../print';
import config from '../config';

export async function monitorCore(
  context: OpticsContext,
  originNetwork: string,
  remoteNetworks: string[],
) {
  const originLogger = config.baseLogger.child({
    originNetwork,
  });

  originLogger.info(`Getting home state and Dispatch logs`);
  const home = context.mustGetCore(originNetwork).home;
  const dispatchFilter = home.filters.Dispatch();
  const dispatchLogs = await getEvents(
    context,
    originNetwork,
    home,
    dispatchFilter,
  );

  const homeState = await home.state();
  config.metrics.setHomeState(originNetwork, config.environment, homeState);

  // Get metrics for each replica
  const processedLogs = [];
  for (const remoteNetwork of remoteNetworks) {
    const remoteLogger = originLogger.child({
      remoteNetwork,
    });
    try {
      const processLogs = await monitorCoreReplica(
        context,
        originNetwork,
        remoteNetwork,
        remoteLogger,
      );
      processedLogs.push(...processLogs);
    } catch (err: any) {
      remoteLogger.warn({
        err
      }, 'Error monitoring core replica');
    }
  }

  const unprocessedDetails = await getUnprocessedDetails(
    originNetwork,
    dispatchLogs,
    processedLogs,
  );

  logMonitorMetrics(
    originNetwork,
    dispatchLogs,
    processedLogs,
    unprocessedDetails,
    originLogger,
  );
  config.metrics.setBridgeState(
    originNetwork,
    config.environment,
    dispatchLogs.length,
    processedLogs.length,
    unprocessedDetails.length,
  );
  // write details to file
  writeUnprocessedMessages(unprocessedDetails, originNetwork);
}

async function monitorCoreReplica(
  context: OpticsContext,
  originNetwork: string,
  remoteNetwork: string,
  logger: Logger,
) {
  logger.info(`Getting replica state and Process logs`);

  const replica = context.mustGetReplicaFor(originNetwork, remoteNetwork);
  const replicaState = await replica.state();
  config.metrics.setReplicaState(
    originNetwork,
    remoteNetwork,
    config.environment,
    replicaState,
  );
  const processFilter = replica.filters.Process();
  const processLogs = await getEvents(
    context,
    remoteNetwork,
    replica,
    processFilter,
  );
  return processLogs;
}

async function getUnprocessedDetails(
  origin: string,
  dispatchLogs: any[],
  processedLogs: any[],
) {
  const processedMessageHashes = processedLogs.map(
    (log: any) => log.args.messageHash,
  );
  const unprocessedMessages = dispatchLogs.filter(
    (log: any) => !processedMessageHashes.includes(log.args.messageHash),
  );
  const promises = unprocessedMessages.map(async (log) => {
    const transaction = await log.getTransaction();
    return {
      chain: origin,
      transactionHash: transaction.hash,
      messageHash: log.args[0],
      leafIndex: log.args[1].toNumber(),
    };
  });
  return Promise.all(promises);
}
