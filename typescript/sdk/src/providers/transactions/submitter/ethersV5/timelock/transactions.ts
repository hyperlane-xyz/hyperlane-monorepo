import { BigNumber } from 'ethers';
import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { Address, CallData, assert, objFilter } from '@hyperlane-xyz/utils';

import {
  GetEventLogsResponse,
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from '../../../../../block-explorer/etherscan.js';
import {
  getExplorerFromChainMetadata,
  viemLogFromGetEventLogsResponse,
} from '../../../../../block-explorer/utils.js';
import { ChainNameOrId } from '../../../../../types.js';
import { MultiProvider } from '../../../../MultiProvider.js';

const CALL_EXECUTED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: TimelockController__factory.abi,
    name: 'CallExecuted',
  }),
);

const CALL_SCHEDULED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: TimelockController__factory.abi,
    name: 'CallScheduled',
  }),
);

const CALL_CANCELLED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: TimelockController__factory.abi,
    name: 'Cancelled',
  }),
);

export type GetPendingTimelockTransactionsOptions = {
  chain: Readonly<ChainNameOrId>;
  timelockAddress: Readonly<Address>;
  multiProvider: Readonly<MultiProvider>;
};

type TimelockTx = {
  id: string;
  delay: number;
  predecessor: string;
  data: [CallData, ...CallData[]];
};

export async function getPendingEvmTimelockControllerTransactions({
  chain,
  multiProvider,
  timelockAddress,
}: GetPendingTimelockTransactionsOptions): Promise<Record<string, TimelockTx>> {
  const explorer = getExplorerFromChainMetadata(chain, multiProvider);
  assert(
    explorer,
    `No explorer was configured correctly to make requests to the API for chain "${chain}". Set an API key or use an explorer API that does not require one`,
  );

  const contractDeploymentTx = await getContractDeploymentTransaction(
    { apiUrl: explorer.apiUrl, apiKey: explorer.apiKey },
    { contractAddress: timelockAddress },
  );

  const provider = multiProvider.getProvider(chain);
  const [currentBlockNumber, deploymentTransactionReceipt] = await Promise.all([
    provider.getBlockNumber(),
    provider.getTransactionReceipt(contractDeploymentTx.txHash),
  ]);

  const events = [];
  for (const eventSignature of [
    CALL_EXECUTED_EVENT_SELECTOR,
    CALL_CANCELLED_EVENT_SELECTOR,
    CALL_SCHEDULED_EVENT_SELECTOR,
  ]) {
    const currentEvents = await getLogsFromEtherscanLikeExplorerAPI(
      {
        apiUrl: explorer.apiUrl,
        apiKey: explorer.apiKey,
      },
      {
        address: timelockAddress,
        fromBlock: deploymentTransactionReceipt.blockNumber,
        toBlock: currentBlockNumber,
        topic0: eventSignature,
      },
    );

    events.push(currentEvents);
  }

  const [callExecutedEvents, callCancelledEvents, callScheduledEvents] = events;
  const cancelledOperationIds =
    getCancelledTimelockOperationIdsFromLogs(callCancelledEvents);
  const executedOperationIds =
    getExecutedTimelockOperationIdsFromLogs(callExecutedEvents);
  const scheduledOperationById =
    getScheduledTimelockOperationIdsFromLogs(callScheduledEvents);

  return objFilter(
    scheduledOperationById,
    (id, _operation): _operation is TimelockTx =>
      !(executedOperationIds.has(id) || cancelledOperationIds.has(id)),
  );
}

export async function getPendingExecutableEvmTimelockControllerTransactions(
  options: GetPendingTimelockTransactionsOptions,
): Promise<Record<string, TimelockTx>> {
  const maybeExecutableOperations =
    await getPendingEvmTimelockControllerTransactions(options);

  const provider = options.multiProvider.getProvider(options.chain);
  const contractInstance = TimelockController__factory.connect(
    options.timelockAddress,
    provider,
  );

  const readyOperationIds = new Set();
  const maybeExecutableTxIds = Object.keys(maybeExecutableOperations);
  for (const operationId of maybeExecutableTxIds) {
    const isReady = await contractInstance.isOperationReady(operationId);

    if (isReady) {
      readyOperationIds.add(operationId);
    }
  }

  return objFilter(
    maybeExecutableOperations,
    (operationId, _operation): _operation is TimelockTx =>
      readyOperationIds.has(operationId),
  );
}

function getCancelledTimelockOperationIdsFromLogs(
  logs: ReadonlyArray<GetEventLogsResponse>,
): Set<string> {
  const result = parseEventLogs({
    abi: TimelockController__factory.abi,
    eventName: 'Cancelled',
    logs: logs.map(viemLogFromGetEventLogsResponse),
  });

  return new Set(result.map((parsedEvent) => parsedEvent.args.id));
}

function getExecutedTimelockOperationIdsFromLogs(
  logs: ReadonlyArray<GetEventLogsResponse>,
): Set<string> {
  const result = parseEventLogs({
    abi: TimelockController__factory.abi,
    eventName: 'CallExecuted',
    logs: logs.map(viemLogFromGetEventLogsResponse),
  });

  return new Set(result.map((parsedEvent) => parsedEvent.args.id));
}

function getScheduledTimelockOperationIdsFromLogs(
  logs: ReadonlyArray<GetEventLogsResponse>,
): Record<string, TimelockTx> {
  const parsedLogs = parseEventLogs({
    abi: TimelockController__factory.abi,
    eventName: 'CallScheduled',
    logs: logs.map(viemLogFromGetEventLogsResponse),
  });

  return parsedLogs.reduce(
    (operationById: Record<string, TimelockTx>, parsedLog) => {
      const { data, delay, id, index, predecessor, target, value } =
        parsedLog.args;

      const currentOperation = operationById[id] ?? {
        data: [],
        delay,
        predecessor,
        id,
      };

      // it should be safe to convert a bigint to number
      // in this case as it is an array index for a Timelock
      // contract operation
      currentOperation.data[Number(index)] = {
        data,
        to: target,
        value: BigNumber.from(value),
      };

      operationById[id] = currentOperation;
      return operationById;
    },
    {},
  );
}
