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
      origin: string;
      destinationChain: ChainName;
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
      chain: '',
    });

    const interchainAccountApp: InterchainAccount =
      await buildInterchainAccountApp(multiProvider, '', {
        origin: '',
        owner: '',
      });

    return new EvmIcaTxSubmitter(
      {
        chain: '',
        destinationChain: '',
        origin: '',
        owner: '',
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
      throw new Error('');
    }

    const [domainId] = transactionChains.values();

    if (!domainId) {
      throw new Error('BOBO');
    }

    const chainName = this.multiProvider.getChainName(domainId);
    if (chainName !== this.config.chain) {
      throw new Error('BOBO');
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
      config: this.config,
    });

    return this.submitter.submit(icaTx);
  }
}
