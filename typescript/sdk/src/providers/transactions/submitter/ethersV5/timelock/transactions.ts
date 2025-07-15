import { BigNumber } from 'ethers';
import { getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import {
  Address,
  CallData,
  HexString,
  assert,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

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

const ZERO_32_BYTES =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

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

const CALL_SALT_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: TimelockController__factory.abi,
    name: 'CallSalt',
  }),
);

export type GetPendingTimelockTransactionsOptions = {
  chain: Readonly<ChainNameOrId>;
  timelockAddress: Readonly<Address>;
  multiProvider: Readonly<MultiProvider>;
};

type TimelockTx = {
  id: HexString;
  delay: number;
  predecessor: HexString;
  salt: HexString;
  data: [CallData, ...CallData[]];
};

type ExecutableTimelockTx = TimelockTx & {
  encodedExecuteTransaction: HexString;
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
    CALL_SALT_EVENT_SELECTOR,
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

  const [
    callExecutedEvents,
    callCancelledEvents,
    callScheduledEvents,
    callSaltEvents,
  ] = events;
  const cancelledOperationIds =
    getCancelledTimelockOperationIdsFromLogs(callCancelledEvents);
  const executedOperationIds =
    getExecutedTimelockOperationIdsFromLogs(callExecutedEvents);
  const scheduledOperationById = getScheduledTimelockOperationIdsFromLogs(
    callScheduledEvents,
    getTimelockOperationSaltByIdFromLogs(callSaltEvents),
  );

  return objFilter(
    scheduledOperationById,
    (id, _operation): _operation is TimelockTx =>
      !(executedOperationIds.has(id) || cancelledOperationIds.has(id)),
  );
}

export async function getPendingExecutableEvmTimelockControllerTransactions(
  options: GetPendingTimelockTransactionsOptions,
): Promise<Record<string, ExecutableTimelockTx>> {
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

  const pendingExecutableTransactions = objFilter(
    maybeExecutableOperations,
    (operationId, _operation): _operation is TimelockTx =>
      readyOperationIds.has(operationId),
  );

  return objMap(
    pendingExecutableTransactions,
    (_operationId, transactionData): ExecutableTimelockTx => {
      return {
        data: transactionData.data,
        delay: transactionData.delay,
        encodedExecuteTransaction:
          getTimelockExecutableTransactionFromBatch(transactionData),
        id: transactionData.id,
        predecessor: transactionData.predecessor,
        salt: transactionData.salt,
      };
    },
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

function getTimelockOperationSaltByIdFromLogs(
  logs: ReadonlyArray<GetEventLogsResponse>,
): Record<string, string> {
  const result = parseEventLogs({
    abi: TimelockController__factory.abi,
    eventName: 'CallSalt',
    logs: logs.map(viemLogFromGetEventLogsResponse),
  });

  return Object.fromEntries(
    result.map((parsedEvent) => [parsedEvent.args.id, parsedEvent.args.salt]),
  );
}

function getScheduledTimelockOperationIdsFromLogs(
  callScheduledLogs: ReadonlyArray<GetEventLogsResponse>,
  callSaltByOperationId: Record<string, string>,
): Record<string, TimelockTx> {
  const parsedLogs = parseEventLogs({
    abi: TimelockController__factory.abi,
    eventName: 'CallScheduled',
    logs: callScheduledLogs.map(viemLogFromGetEventLogsResponse),
  });

  return parsedLogs.reduce(
    (operationsById: Record<string, TimelockTx>, parsedLog) => {
      const { data, delay, id, index, predecessor, target, value } =
        parsedLog.args;

      if (!operationsById[id]) {
        operationsById[id] = {
          data: [
            {
              data,
              to: target,
              value: BigNumber.from(value),
            },
          ],
          delay: Number(delay),
          predecessor,
          // If no CallSalt event was emitted for this operation batch
          // it means that no salt was provided when proposing the transaction
          salt: callSaltByOperationId[id] ?? ZERO_32_BYTES,
          id,
        };
      } else {
        // it should be safe to convert a bigint to number
        // in this case as it is an array index for a Timelock
        // contract operation
        operationsById[id].data[Number(index)] = {
          data,
          to: target,
          value: BigNumber.from(value),
        };
      }

      return operationsById;
    },
    {},
  );
}

function getTimelockExecutableTransactionFromBatch(
  transactionData: TimelockTx,
): HexString {
  const [to, data, value] = transactionData.data.reduce(
    ([targets, data, values], item) => {
      targets.push(item.to);
      data.push(item.data);
      values.push(item.value?.toString() ?? '0');

      return [targets, data, values];
    },
    [[], [], []] as [string[], string[], string[]],
  );

  return TimelockController__factory.createInterface().encodeFunctionData(
    'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)',
    [to, value, data, transactionData.predecessor, transactionData.salt],
  );
}
