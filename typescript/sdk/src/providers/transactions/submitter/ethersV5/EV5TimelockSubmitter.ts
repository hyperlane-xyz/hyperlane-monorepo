import {
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { EMPTY_BYTES_32 } from '../../../../timelock/evm/constants.js';
import { ChainMap } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  ProtocolTypedReceipt,
} from '../../../ProviderType.js';
import { CallData } from '../../types.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { getSubmitter } from '../submitterBuilderGetter.js';

import { EvmTimelockControllerSubmitterProps } from './types.js';

type EvmTimelockControllerSubmitterConstructorConfig = Required<
  Pick<
    EvmTimelockControllerSubmitterProps,
    'chain' | 'predecessor' | 'delay' | 'salt'
  >
>;

export class EV5TimelockSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.TIMELOCK_CONTROLLER;

  protected constructor(
    protected readonly config: EvmTimelockControllerSubmitterConstructorConfig,
    protected readonly multiProvider: MultiProvider,
    protected readonly proposerSubmitter: TxSubmitterInterface<ProtocolType.Ethereum>,
    protected readonly timelockInstance: TimelockController,
  ) {}

  static async fromConfig(
    config: EvmTimelockControllerSubmitterProps,
    multiProvider: MultiProvider,
    coreAddressesByChain: ChainMap<Record<string, string>>,
  ): Promise<EV5TimelockSubmitter> {
    const provider = multiProvider.getProvider(config.chain);
    const timelockInstance = TimelockController__factory.connect(
      config.timelockAddress,
      provider,
    );

    const minDelay = (await timelockInstance.getMinDelay()).toBigInt();
    const delay = config.delay ?? minDelay;
    assert(
      delay >= minDelay,
      `Expected user supplied delay ${delay} to be greater or equal than the configured minDelay ${minDelay}`,
    );

    const proposerSubmitter = await getSubmitter<ProtocolType.Ethereum>(
      multiProvider,
      config.proposerSubmitter,
      coreAddressesByChain,
    );

    return new EV5TimelockSubmitter(
      {
        chain: config.chain,
        delay,
        predecessor: config.predecessor ?? EMPTY_BYTES_32,
        salt: config.salt ?? EMPTY_BYTES_32,
      },
      multiProvider,
      proposerSubmitter,
      timelockInstance,
    );
  }

  async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<
    | void
    | ProtocolTypedReceipt<ProtocolType.Ethereum>['receipt']
    | ProtocolTypedReceipt<ProtocolType.Ethereum>['receipt'][]
  > {
    if (txs.length === 0) {
      return [];
    }

    const transactionChains = new Set(txs.map((tx) => tx.chainId));
    if (transactionChains.size !== 1) {
      throw new Error(
        'TimelockController transactions should have all the same destination chain',
      );
    }

    // If no domain id is set on the transactions
    // assume they are to be sent on the current configured chain
    const [domainId] = transactionChains.values();
    const destinationChainDomainId = this.multiProvider.getDomainId(
      domainId ?? this.config.chain,
    );

    const calldata: CallData[] = txs.map((transaction): CallData => {
      assert(transaction.data, 'Invalid Transaction: data must be defined');
      assert(
        transaction.to,
        'Invalid Transaction: target address must be defined',
      );

      return {
        to: transaction.to,
        data: transaction.data,
        value: transaction.value?.toString(),
      };
    });

    const [to, data, value] = calldata.reduce<[string[], string[], string[]]>(
      ([targets, data, values], item) => {
        targets.push(item.to);
        data.push(item.data);
        values.push(item.value ?? '0');

        return [targets, data, values];
      },
      [[], [], []],
    );

    // The Timelock keeps track of past operations so even if it has been
    // executed we need to check if there was in the past an operation with the same id
    // as this one to avoid having it fail as it would have the same id if no salt is given
    const operationId = await this.timelockInstance.hashOperationBatch(
      to,
      value,
      data,
      this.config.predecessor,
      this.config.salt,
    );
    const checkStatus = await this.timelockInstance.isOperation(operationId);
    assert(
      !checkStatus,
      `Operation with id "${operationId}" already exists. If this is a new operation with the same input as another one provide a salt to generate a different operation id or cancel the existing one if it is still pending.`,
    );

    const [proposeCallData, executeCallData] = await Promise.all([
      this.timelockInstance.populateTransaction.scheduleBatch(
        to,
        value,
        data,
        this.config.predecessor,
        this.config.salt,
        this.config.delay,
      ),
      this.timelockInstance.populateTransaction.executeBatch(
        to,
        value,
        data,
        this.config.predecessor,
        this.config.salt,
      ),
    ]);

    const proposeFormattedCallData = await this.proposerSubmitter.submit({
      chainId: destinationChainDomainId,
      ...proposeCallData,
    });

    if (!proposeFormattedCallData) {
      // Appending the execute transaction so that it can be written to a file
      // by the caller
      return [executeCallData as any];
    }

    const proposeTransactions = Array.isArray(proposeFormattedCallData)
      ? proposeFormattedCallData
      : [proposeFormattedCallData];
    // Appending the execute transaction so that it can be written to a file
    // by the caller
    return [...proposeTransactions, executeCallData as any];
  }
}
