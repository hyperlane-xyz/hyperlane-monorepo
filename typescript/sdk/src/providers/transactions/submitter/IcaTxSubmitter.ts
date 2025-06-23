import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  InterchainAccount,
  buildInterchainAccountApp,
} from '../../../middleware/account/InterchainAccount.js';
import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  ProtocolTypedReceipt,
} from '../../ProviderType.js';
import { CallData } from '../types.js';

import { TxSubmitterInterface } from './TxSubmitterInterface.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';
import { EV5GnosisSafeTxBuilder } from './ethersV5/EV5GnosisSafeTxBuilder.js';
import { EV5GnosisSafeTxSubmitter } from './ethersV5/EV5GnosisSafeTxSubmitter.js';
import { EV5ImpersonatedAccountTxSubmitter } from './ethersV5/EV5ImpersonatedAccountTxSubmitter.js';
import { EV5JsonRpcTxSubmitter } from './ethersV5/EV5JsonRpcTxSubmitter.js';
import { EvmIcaTxSubmitterProps } from './types.js';

type EvmIcaTxSubmitterConfig = EvmIcaTxSubmitterProps & {
  originInterchainAccountRouter: Address;
};

type EvmIcaTxSubmitterConstructorConfig = Omit<
  EvmIcaTxSubmitterConfig,
  'internalSubmitter' | 'type'
> & {
  owner: Address;
};

type SubmitterFactoryMapping<
  E extends TxSubmitterType,
  TConfig extends { type: E },
  TResult,
> = {
  [K in E]: (
    config: Extract<TConfig, { type: K }>,
  ) => Promise<TResult> | TResult;
};

async function getInternalSubmitter(
  chain: ChainName,
  multiProvider: MultiProvider,
  config: EvmIcaTxSubmitterConfig['internalSubmitter'],
): Promise<TxSubmitterInterface<ProtocolType.Ethereum>> {
  const internalSubmitterMap: SubmitterFactoryMapping<
    EvmIcaTxSubmitterConfig['internalSubmitter']['type'],
    EvmIcaTxSubmitterConfig['internalSubmitter'],
    TxSubmitterInterface<ProtocolType.Ethereum>
  > = {
    [TxSubmitterType.GNOSIS_SAFE]: (config) => {
      return EV5GnosisSafeTxSubmitter.create(multiProvider, {
        ...config,
      });
    },
    [TxSubmitterType.GNOSIS_TX_BUILDER]: (config) => {
      return EV5GnosisSafeTxBuilder.create(multiProvider, {
        ...config,
      });
    },
    [TxSubmitterType.IMPERSONATED_ACCOUNT]: (config) => {
      return new EV5ImpersonatedAccountTxSubmitter(multiProvider, {
        ...config,
      });
    },
    [TxSubmitterType.JSON_RPC]: (config) => {
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        ...config,
      });
    },
  };

  const internalSubmitterFactory = internalSubmitterMap[config.type];
  // Sanity check
  if (!internalSubmitterFactory) {
    throw new Error(
      `Internal submitter factory not found for type: ${config.type}`,
    );
  }

  return internalSubmitterFactory(config as any);
}

export class EvmIcaTxSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.INTERCHAIN_ACCOUNT;

  private constructor(
    private readonly config: EvmIcaTxSubmitterConstructorConfig,
    private readonly submitter: TxSubmitterInterface<ProtocolType.Ethereum>,
    private readonly multiProvider: MultiProvider,
    private readonly interchainAccountApp: InterchainAccount,
  ) {}

  static async fromConfig(
    config: EvmIcaTxSubmitterConfig,
    multiProvider: MultiProvider,
  ): Promise<EvmIcaTxSubmitter> {
    const internalSubmitter = await getInternalSubmitter(
      config.chain,
      multiProvider,
      config.internalSubmitter,
    );

    const owner =
      config.owner ?? (await multiProvider.getSignerAddress(config.chain));

    const interchainAccountApp: InterchainAccount =
      await buildInterchainAccountApp(multiProvider, config.chain, {
        owner,
        origin: config.chain,
        localRouter: config.originInterchainAccountRouter,
      });

    return new EvmIcaTxSubmitter(
      {
        owner,
        chain: config.chain,
        destinationChain: config.destinationChain,
        originInterchainAccountRouter: config.originInterchainAccountRouter,
      },
      internalSubmitter,
      multiProvider,
      interchainAccountApp,
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
        'ICA transactions should have all the same destination chain',
      );
    }

    const [domainId] = transactionChains.values();
    if (!domainId) {
      throw new Error(
        'Destination domain for ICA transactions should be defined',
      );
    }

    const chainName = this.multiProvider.getChainName(domainId);
    if (chainName !== this.config.destinationChain) {
      throw new Error(
        `Destination chain mismatch expected ${this.config.destinationChain} but received ${chainName}`,
      );
    }

    const innerCalls: CallData[] = txs.map(
      ({ to, data, chainId, value }): CallData => {
        assert(chainId, 'Invalid PopulatedTransaction: "chainId" is required');
        assert(to, 'Invalid PopulatedTransaction: "to" is required');
        assert(data, 'Invalid PopulatedTransaction: "data" is required');

        return { data, to, value: value?.toString() };
      },
    );

    const icaTx = await this.interchainAccountApp.getCallRemote({
      chain: this.config.chain,
      destination: this.config.destinationChain,
      innerCalls,
      config: {
        origin: this.config.chain,
        owner: this.config.owner,
        ismOverride: this.config.interchainSecurityModule,
        routerOverride: this.config.destinationInterchainAccountRouter,
        localRouter: this.config.originInterchainAccountRouter,
      },
    });

    return this.submitter.submit({
      chainId: this.multiProvider.getDomainId(this.config.chain),
      ...icaTx,
    });
  }
}
