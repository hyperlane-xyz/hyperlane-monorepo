import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  InterchainAccount,
  buildInterchainAccountApp,
} from '../../../middleware/account/InterchainAccount.js';
import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  ProtocolTypedProvider,
  ProtocolTypedReceipt,
} from '../../ProviderType.js';
import { CallData } from '../types.js';

import { TxSubmitterInterface } from './TxSubmitterInterface.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';
import { EV5JsonRpcTxSubmitter } from './ethersV5/EV5JsonRpcTxSubmitter.js';

interface EvmIcaTxSubmitterConfig {
  type: TxSubmitterType.INTERCHAIN_ACCOUNT;
  chain: ChainName;
  destinationChain: ChainName;
  owner: Address;
  originInterchainAccountRouter?: Address;
  destinationInterchainAccountRouter?: Address;
  interchainSecurityModule?: Address;
}

export class EvmIcaTxSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  provider?:
    | ProtocolTypedProvider<ProtocolType.Ethereum>['provider']
    | undefined;
  readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.INTERCHAIN_ACCOUNT;

  private constructor(
    private readonly config: {
      chain: ChainName;
      owner: string;
      destinationChain: ChainName;
      originInterchainAccountRouter?: Address;
      destinationInterchainAccountRouter?: Address;
      interchainSecurityModule?: Address;
    },
    private readonly submitter: TxSubmitterInterface<ProtocolType.Ethereum>,
    private readonly multiProvider: MultiProvider,
    private readonly interchainAccountApp: InterchainAccount,
  ) {}

  static async fromConfig(
    config: EvmIcaTxSubmitterConfig,
    multiProvider: MultiProvider,
  ): Promise<EvmIcaTxSubmitter> {
    const jsonRpcSubmitter = new EV5JsonRpcTxSubmitter(multiProvider, {
      chain: config.chain,
    });

    const interchainAccountApp: InterchainAccount =
      await buildInterchainAccountApp(multiProvider, config.chain, {
        origin: config.chain,
        owner: config.owner,
        localRouter: config.originInterchainAccountRouter,
      });

    return new EvmIcaTxSubmitter(
      {
        chain: config.chain,
        destinationChain: config.destinationChain,
        owner: config.owner,
        originInterchainAccountRouter: config.originInterchainAccountRouter,
      },
      jsonRpcSubmitter,
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
