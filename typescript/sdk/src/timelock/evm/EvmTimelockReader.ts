import { BigNumber, constants } from 'ethers';
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
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import {
  EvmEventLogsReader,
  EvmEventLogsReaderConfig,
} from '../../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../../rpc/evm/types.js';
import { viemLogFromGetEventLogsResponse } from '../../rpc/evm/utils.js';
import { ChainNameOrId } from '../../types.js';
import { ExecutableTimelockTx, TimelockTx } from '../types.js';

import {
  CANCELLER_ROLE,
  EMPTY_BYTES_32,
  EXECUTOR_ROLE,
  PROPOSER_ROLE,
} from './constants.js';
import { getTimelockExecutableTransactionFromBatch } from './utils.js';

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
} & EvmEventLogsReaderConfig;

export class EvmTimelockReader {
  protected constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly multiProvider: MultiProvider,
    protected timelockInstance: TimelockController,
    protected evmLogReader: EvmEventLogsReader,
  ) {}

  static fromConfig(config: EvmTimelockReaderConfig): EvmTimelockReader {
    const {
      chain,
      timelockAddress,
      multiProvider,
      useRPC,
      paginationBlockRange,
    } = config;

    const timelockInstance = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(chain),
    );

    const evmLogReader = EvmEventLogsReader.fromConfig(
      { chain, useRPC, paginationBlockRange },
      multiProvider,
    );

    return new EvmTimelockReader(
      chain,
      multiProvider,
      timelockInstance,
      evmLogReader,
    );
  }

  async getOperationsSalt(): Promise<Record<string, string>> {
    const logs = await this.evmLogReader.getLogsByTopic({
      contractAddress: this.timelockInstance.address,
      eventTopic: CALL_SALT_EVENT_SELECTOR,
    });

    const result = parseEventLogs({
      abi: TimelockController__factory.abi,
      eventName: 'CallSalt',
      logs: logs.map(viemLogFromGetEventLogsResponse),
    });

    return Object.fromEntries(
      result.map((parsedEvent) => [parsedEvent.args.id, parsedEvent.args.salt]),
    );
  }

  async getScheduledOperations(): Promise<Record<string, TimelockTx>> {
    const [callScheduledEvents, callSaltByOperationId] = await Promise.all([
      this.evmLogReader.getLogsByTopic({
        contractAddress: this.timelockInstance.address,
        eventTopic: CALL_SCHEDULED_EVENT_SELECTOR,
      }),
      this.getOperationsSalt(),
    ]);

    return getScheduledTimelockOperationIdsFromLogs(
      callScheduledEvents,
      callSaltByOperationId,
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
    const executedOperationEvents = await this.evmLogReader.getLogsByTopic({
      contractAddress: this.timelockInstance.address,
      eventTopic: CALL_EXECUTED_EVENT_SELECTOR,
    });

    return getOperationIdFromEventLogs(executedOperationEvents, 'CallExecuted');
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
    const [scheduledOperations, cancelledOperations, executedOperations] =
      await Promise.all([
        this.getScheduledOperations(),
        this.getCancelledOperationIds(),
        this.getExecutedOperationIds(),
      ]);

    // Remove the operations that have been cancelled or executed
    const maybeExecutableOperations = objFilter(
      scheduledOperations,
      (id, _operation): _operation is TimelockTx =>
        !(cancelledOperations.has(id) || executedOperations.has(id)),
    );

    const readyOperationIds = await this.getReadyOperationIds(
      Object.keys(maybeExecutableOperations),
    );

    const pendingExecutableOperations = objFilter(
      maybeExecutableOperations,
      (operationId, _operation): _operation is TimelockTx =>
        readyOperationIds.has(operationId),
    );

    return objMap(
      pendingExecutableOperations,
      (_operationId, operationData): ExecutableTimelockTx => {
        return {
          data: operationData.data,
          delay: operationData.delay,
          encodedExecuteTransaction:
            getTimelockExecutableTransactionFromBatch(operationData),
          id: operationData.id,
          predecessor: operationData.predecessor,
          salt: operationData.salt,
        };
      },
    );
  }

  async hasRole(address: Address, role: string): Promise<boolean> {
    // If the 0 address has the role anyone has the role
    const [hasRole, isOpenRole] = await Promise.all([
      this.timelockInstance.hasRole(role, address),
      this.timelockInstance.hasRole(role, constants.AddressZero),
    ]);

    return hasRole || isOpenRole;
  }

  async canExecuteOperations(address: Address): Promise<boolean> {
    return this.hasRole(address, EXECUTOR_ROLE);
  }

  async canCancelOperations(address: Address): Promise<boolean> {
    return this.hasRole(address, CANCELLER_ROLE);
  }

  async canScheduleOperations(address: Address): Promise<boolean> {
    return this.hasRole(address, PROPOSER_ROLE);
  }
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
          salt: callSaltByOperationId[id] ?? EMPTY_BYTES_32,
          id,
        };
      } else {
        // it should be safe to convert a bigint to number
        // in this case as it is an array index for a Timelock
        // contract operation
        operationsById[id].data[Number(index.toString())] = {
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

function getOperationIdFromEventLogs(
  logs: ReadonlyArray<GetEventLogsResponse>,
  eventName: Extract<
    ContractEventName<typeof TimelockController__factory.abi>,
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
