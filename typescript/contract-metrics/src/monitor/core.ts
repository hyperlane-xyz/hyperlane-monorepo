import { AbacusCore, getEvents } from '@abacus-network/sdk';
import { ChainName, Remotes } from '@abacus-network/sdk/dist/types';
import Logger from 'bunyan';
import config from '../config';
import { logMonitorMetrics, writeUnprocessedMessages } from '../print';

export async function monitorCore<Local extends ChainName>(
  core: AbacusCore,
  originNetwork: Remotes<ChainName, Local>,
  remoteNetworks: Local[],
) {
  const originLogger = config.baseLogger.child({
    originNetwork,
  });

  originLogger.info(`Getting outbox state and Dispatch logs`);
  const outbox = core.mustGetContracts(originNetwork).outbox;
  const dispatchFilter = outbox.filters.Dispatch();
  const dispatchLogs = await getEvents(
    core,
    originNetwork,
    outbox,
    dispatchFilter,
  );

  const outboxState = await outbox.state();
  config.metrics.setOutboxState(originNetwork, config.environment, outboxState);

  // Get metrics for each inbox
  const processedLogs = [];
  for (const remoteNetwork of remoteNetworks) {
    const remoteLogger = originLogger.child({
      remoteNetwork,
    });
    const processLogs = await monitorCoreInbox(
      core,
      originNetwork,
      remoteNetwork,
      remoteLogger,
    );
    processedLogs.push(...processLogs);
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

async function monitorCoreInbox<Local extends ChainName>(
  core: AbacusCore,
  originNetwork: Remotes<ChainName, Local>,
  remoteNetwork: Local,
  logger: Logger,
) {
  logger.info(`Getting inbox state and Process logs`);

  const inbox = core.mustGetInbox(originNetwork as any, remoteNetwork as any);
  const processFilter = inbox.filters.Process();
  const processLogs = await getEvents(
    core,
    remoteNetwork,
    inbox,
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
