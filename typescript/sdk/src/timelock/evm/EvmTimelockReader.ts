import { BigNumber } from 'ethers';
import {
  ContractEventName,
  getAbiItem,
  parseEventLogs,
  toEventSelector,
} from 'viem';

import {
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  CallData,
  HexString,
  objFilter,
  objMap,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../../rpc/evm/types.js';
import { viemLogFromGetEventLogsResponse } from '../../rpc/evm/utils.js';
import { ChainNameOrId } from '../../types.js';

import { getTimelockExecutableTransactionFromBatch } from './utils.js';

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

export type EvmTimelockReaderConfig = {
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

export class EvmTimelockReader {
  protected constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly multiProvider: MultiProvider,
    protected timelockInstance: TimelockController,
    protected evmLogReader: EvmEventLogsReader,
  ) {}

  async getScheduledTransactions(): Promise<Record<string, TimelockTx>> {
    const [callScheduledEvents, callSaltEvents] = await Promise.all([
      this.evmLogReader.getLogsByTopic({
        contractAddress: this.timelockInstance.address,
        eventTopic: CALL_SCHEDULED_EVENT_SELECTOR,
      }),
      this.evmLogReader.getLogsByTopic({
        contractAddress: this.timelockInstance.address,
        eventTopic: CALL_SALT_EVENT_SELECTOR,
      }),
    ]);

    return getScheduledTimelockOperationIdsFromLogs(
      callScheduledEvents,
      getTimelockOperationSaltByIdFromLogs(callSaltEvents),
    );
  }

  async getCancelledOperationIds(): Promise<Set<string>> {
    const cancelledOperationEvents = await this.evmLogReader.getLogsByTopic({
      contractAddress: this.timelockInstance.address,
      eventTopic: CALL_CANCELLED_EVENT_SELECTOR,
    });

    return getOperationIdFromEventLogs(cancelledOperationEvents, 'Cancelled');
  }

  async getExecutedOperationIds(): Promise<Set<string>> {
    const cancelledOperationEvents = await this.evmLogReader.getLogsByTopic({
      contractAddress: this.timelockInstance.address,
      eventTopic: CALL_EXECUTED_EVENT_SELECTOR,
    });

    return getOperationIdFromEventLogs(
      cancelledOperationEvents,
      'CallExecuted',
    );
  }

  async getReadyOperationIds(operationIds: string[]): Promise<Set<string>> {
    const readyOperationIds = new Set<string>();
    for (const operationId of operationIds) {
      const isReady = await this.timelockInstance.isOperationReady(operationId);

      if (isReady) {
        readyOperationIds.add(operationId);
      }
    }

    return readyOperationIds;
  }

  async getScheduledExecutableTransactions(): Promise<
    Record<string, ExecutableTimelockTx>
  > {
    const [scheduledTransactions, cancelledTransactions, executedTransactions] =
      await Promise.all([
        this.getScheduledTransactions(),
        this.getCancelledOperationIds(),
        this.getExecutedOperationIds(),
      ]);

    const maybeExecutableOperations = objFilter(
      scheduledTransactions,
      (id, _operation): _operation is TimelockTx =>
        !(cancelledTransactions.has(id) || executedTransactions.has(id)),
    );

    const readyOperationIds = await this.getReadyOperationIds(
      Object.keys(maybeExecutableOperations),
    );

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

type AllEvents = ContractEventName<typeof TimelockController__factory.abi>;

function getOperationIdFromEventLogs(
  logs: ReadonlyArray<GetEventLogsResponse>,
  eventName: Extract<
    AllEvents,
    'CallScheduled' | 'CallExecuted' | 'Cancelled' | 'CallSalt'
  >,
): Set<string> {
  const result = parseEventLogs({
    abi: TimelockController__factory.abi,
    eventName: eventName,
    logs: logs.map(viemLogFromGetEventLogsResponse),
  });

  return new Set(result.map((parsedEvent) => parsedEvent.args.id));
}
