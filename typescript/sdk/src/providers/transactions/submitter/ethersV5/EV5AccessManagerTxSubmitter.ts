import { Logger } from 'pino';

import { IAccessManager, IAccessManager__factory } from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  ensure0x,
  rootLogger,
  strip0x,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  ProtocolTypedReceipt,
} from '../../../ProviderType.js';
import { CallData } from '../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';
import { AccessManagerSubmitterConfig } from './types.js';

export class EV5AccessManagerTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.ACCESS_MANAGER;

  protected readonly logger: Logger = rootLogger.child({
    module: 'access-manager-submitter',
  });

  constructor(
    protected readonly config: AccessManagerSubmitterConfig,
    public readonly multiProvider: MultiProvider,
    protected readonly proposerSubmitter: EV5TxSubmitterInterface,
    protected readonly accessManager: IAccessManager,
  ) {}

  static async create(
    config: AccessManagerSubmitterConfig,
    multiProvider: MultiProvider,
    proposerSubmitter: EV5TxSubmitterInterface,
  ): Promise<EV5AccessManagerTxSubmitter> {
    const provider = multiProvider.getProvider(config.chain);
    const accessManager = IAccessManager__factory.connect(
      config.accessManagerAddress,
      provider,
    );

    return new EV5AccessManagerTxSubmitter(
      config,
      multiProvider,
      proposerSubmitter,
      accessManager,
    );
  }

  address(): Address {
    return this.accessManager.address;
  }

  private selector(data: string): string {
    return ensure0x(strip0x(data).slice(0, 8));
  }

  async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<
    | void
    | ProtocolTypedReceipt<any>['receipt']
    | ProtocolTypedReceipt<any>['receipt'][]
  > {
    if (txs.length === 0) {
      return [];
    }

    // Convert transactions to call data format
    const calldata: CallData[] = txs.map((transaction): CallData => {
      assert(transaction.data, 'Invalid Transaction: data must be defined');
      assert(
        transaction.to,
        'Invalid Transaction: target address must be defined',
      );
      assert(
        !transaction.value || transaction.value.toString() === '0',
        'Access Manager transactions cannot have a value',
      );

      return {
        to: transaction.to,
        data: transaction.data,
      };
    });

    const targets = new Set(calldata.map((call) => call.to));
    if (targets.size !== txs.length) {
      throw new Error(
        'AccessManager transactions cannot have duplicate targets',
      );
    }

    const caller = await this.proposerSubmitter.address();
    const isImmediate = await Promise.all(
      calldata.map(async (call) => {
        const operationId = await this.accessManager.hashOperation(
          caller,
          call.to,
          call.data,
        );
        // IAccessManager.getSchedule() returns 0 if the operation is not yet scheduled, has expired, was executed, or was canceled.
        const schedule = await this.accessManager.getSchedule(operationId);
        assert(
          schedule === 0,
          `AccessManager operation exists "${operationId}" already`,
        );

        const [allowed, delay] = await this.accessManager.canCall(
          caller,
          call.to,
          this.selector(call.data),
        );
        if (!allowed) {
          throw new Error(
            `AccessManager caller ${caller} does not have permission for ${call.to} with ${call.data}`,
          );
        }

        return delay === 0;
      }),
    );

    const scheduleCalls = calldata.map((call) => ({
      to: this.accessManager.address,
      data: this.accessManager.interface.encodeFunctionData('schedule', [
        call.to,
        call.data,
        0,
      ]),
      annotation: `Schedule ${call.to} with ${call.data} on AccessManager ${this.accessManager.address}`,
    }));
    const executeCalls = calldata.map((call) => ({
      to: this.accessManager.address,
      data: this.accessManager.interface.encodeFunctionData('execute', [
        call.to,
        call.data,
      ]),
      annotation: `Execute ${call.to} with ${call.data} on AccessManager ${this.accessManager.address}`,
    }));

    const proposerCalls = [
      ...scheduleCalls.filter((_call, index) => !isImmediate[index]),
      ...executeCalls.filter((_call, index) => isImmediate[index]),
    ];
    const executeLaterCalls = executeCalls.filter(
      (_call, index) => !isImmediate[index],
    );

    // TODO: fix types of composed submitters
    const bubbledUpCalls: any = await this.proposerSubmitter.submit(
      ...proposerCalls,
    );
    if (!Array.isArray(bubbledUpCalls)) {
      return executeLaterCalls;
    } else {
      return [...executeLaterCalls, ...bubbledUpCalls];
    }
  }
}
