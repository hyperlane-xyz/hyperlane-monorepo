import {
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { IRegistry } from '@hyperlane-xyz/registry';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

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

const ZERO_32_BYTES =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

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
    registry: Readonly<IRegistry>,
  ): Promise<EV5TimelockSubmitter> {
    const provider = multiProvider.getProvider(config.chain);
    const timelockInstance = TimelockController__factory.connect(
      config.timelockAddress,
      provider,
    );

    const minDelay = await timelockInstance.getMinDelay();

    const delay = config.delay ?? minDelay.toBigInt();

    assert(delay >= minDelay.toBigInt(), '');

    const internalSubmitter = await getSubmitter<ProtocolType.Ethereum>(
      multiProvider,
      config.proposerSubmitter,
      registry,
    );

    return new EV5TimelockSubmitter(
      {
        chain: config.chain,
        delay,
        predecessor: config.predecessor ?? ZERO_32_BYTES,
        salt: config.salt ?? ZERO_32_BYTES,
      },
      multiProvider,
      internalSubmitter,
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
    const destinationChain = this.multiProvider.getDomainId(
      domainId ?? this.config.chain,
    );

    const calldata: CallData[] = txs.map((transaction): CallData => {
      assert(transaction.data, '');
      assert(transaction.to, '');

      return {
        to: transaction.to,
        data: transaction.data,
        value: transaction.value?.toString(),
      };
    });

    const [to, data, value] = calldata.reduce(
      ([targets, data, values], item) => {
        targets.push(item.to);
        data.push(item.data);
        values.push(item.value ?? '0');

        return [targets, data, values];
      },
      [[], [], []] as [string[], string[], string[]],
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
      chainId: destinationChain,
      ...proposeCallData,
    });

    if (!proposeFormattedCallData) {
      return [];
    }

    if (Array.isArray(proposeFormattedCallData)) {
      return [...proposeFormattedCallData, executeCallData as any];
    }

    return [proposeFormattedCallData, executeCallData as any];
  }
}
