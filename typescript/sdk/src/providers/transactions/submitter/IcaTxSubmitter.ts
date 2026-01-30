import {
  Address,
  ProtocolType,
  assert,
  bytes32ToAddress,
  formatStandardHookMetadata,
} from '@hyperlane-xyz/utils';

import {
  InterchainAccount,
  buildInterchainAccountApp,
} from '../../../middleware/account/InterchainAccount.js';
import { ChainMap } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  ProtocolTypedReceipt,
} from '../../ProviderType.js';
import { CallData } from '../types.js';

import { TxSubmitterInterface } from './TxSubmitterInterface.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';
import { EvmIcaTxSubmitterProps } from './ethersV5/types.js';
import { getSubmitter } from './submitterBuilderGetter.js';

type EvmIcaTxSubmitterConstructorConfig = Omit<
  EvmIcaTxSubmitterProps,
  'internalSubmitter' | 'type'
> & {
  originInterchainAccountRouter: Address;
};

export class EvmIcaTxSubmitter
  implements TxSubmitterInterface<ProtocolType.Ethereum>
{
  readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.INTERCHAIN_ACCOUNT;

  protected constructor(
    protected readonly config: EvmIcaTxSubmitterConstructorConfig,
    protected readonly submitter: TxSubmitterInterface<ProtocolType.Ethereum>,
    protected readonly multiProvider: MultiProvider,
    protected readonly interchainAccountApp: InterchainAccount,
  ) {}

  static async fromConfig(
    config: EvmIcaTxSubmitterProps,
    multiProvider: MultiProvider,
    coreAddressesByChain: Readonly<ChainMap<Record<string, string>>>,
  ): Promise<EvmIcaTxSubmitter> {
    const interchainAccountRouterAddress: Address | undefined =
      config.originInterchainAccountRouter ??
      coreAddressesByChain[config.chain].interchainAccountRouter;
    assert(
      interchainAccountRouterAddress,
      `Origin chain InterchainAccountRouter address not supplied and none found in the registry metadata for chain ${config.chain}`,
    );

    const internalSubmitter = await getSubmitter<ProtocolType.Ethereum>(
      multiProvider,
      config.internalSubmitter,
      coreAddressesByChain,
    );

    const interchainAccountApp: InterchainAccount =
      await buildInterchainAccountApp(
        multiProvider,
        config.chain,
        {
          owner: config.owner,
          origin: config.chain,
          localRouter: interchainAccountRouterAddress,
          ismOverride: config.interchainSecurityModule,
        },
        coreAddressesByChain,
      );

    return new EvmIcaTxSubmitter(
      {
        owner: config.owner,
        chain: config.chain,
        destinationChain: config.destinationChain,
        originInterchainAccountRouter: interchainAccountRouterAddress,
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

    const [chainId] = transactionChains.values();
    if (!chainId) {
      throw new Error(
        'Destination domain for ICA transactions should be defined',
      );
    }

    const { chainId: destinationEvmChainId, domainId: destinationDomainId } =
      this.multiProvider.getChainMetadata(this.config.destinationChain);

    // On the EVM chains the id and domain id might be different so we match either against the
    // EVM chain id or the Hyperlane domain id
    if (chainId !== destinationDomainId && chainId !== destinationEvmChainId) {
      throw new Error(
        `Destination chain mismatch. Expected EVM chain id ${destinationEvmChainId} or Hyperlane domain id ${destinationDomainId} but received ${chainId}.`,
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

    const refundAddress = bytes32ToAddress(this.config.owner);
    const hookMetadata = formatStandardHookMetadata({ refundAddress });

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
      hookMetadata,
    });

    return this.submitter.submit({
      chainId: this.multiProvider.getDomainId(this.config.chain),
      ...icaTx,
    });
  }
}
