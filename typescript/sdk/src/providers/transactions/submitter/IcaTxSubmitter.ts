import {
  Address,
  ProtocolType,
  assert,
  bytes32ToAddress,
  formatStandardHookMetadata,
  normalizeAddressEvm,
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
import type { SubmitterGetter } from './types.js';

type EvmIcaTxSubmitterConstructorConfig = Omit<
  EvmIcaTxSubmitterProps,
  'internalSubmitter' | 'type'
> & {
  originInterchainAccountRouter: Address;
};

export class EvmIcaTxSubmitter implements TxSubmitterInterface<ProtocolType.Ethereum> {
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
    getSubmitterFn: SubmitterGetter,
  ): Promise<EvmIcaTxSubmitter> {
    const interchainAccountRouterAddress: Address | undefined =
      config.originInterchainAccountRouter ??
      coreAddressesByChain[config.chain].interchainAccountRouter;
    assert(
      interchainAccountRouterAddress,
      `Origin chain InterchainAccountRouter address not supplied and none found in the registry metadata for chain ${config.chain}`,
    );

    // Canonicalize the EVM addresses up front so a config value with a valid
    // shape but bad EIP-55 casing doesn't throw deep inside ethers mid-submission.
    const owner = normalizeAddressEvm(config.owner);
    const originInterchainAccountRouter = normalizeAddressEvm(
      interchainAccountRouterAddress,
    );
    const destinationInterchainAccountRouter =
      config.destinationInterchainAccountRouter
        ? normalizeAddressEvm(config.destinationInterchainAccountRouter)
        : undefined;
    const interchainSecurityModule = config.interchainSecurityModule
      ? normalizeAddressEvm(config.interchainSecurityModule)
      : undefined;

    const internalSubmitter = await getSubmitterFn<ProtocolType.Ethereum>(
      multiProvider,
      config.internalSubmitter,
      coreAddressesByChain,
    );

    const interchainAccountApp: InterchainAccount =
      await buildInterchainAccountApp(
        multiProvider,
        config.chain,
        {
          owner,
          origin: config.chain,
          localRouter: originInterchainAccountRouter,
          ismOverride: interchainSecurityModule,
        },
        coreAddressesByChain,
      );

    return new EvmIcaTxSubmitter(
      {
        owner,
        chain: config.chain,
        destinationChain: config.destinationChain,
        originInterchainAccountRouter,
        destinationInterchainAccountRouter,
        interchainSecurityModule,
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
    const icaConfig = {
      origin: this.config.chain,
      owner: this.config.owner,
      ismOverride: this.config.interchainSecurityModule,
      routerOverride: this.config.destinationInterchainAccountRouter,
      localRouter: this.config.originInterchainAccountRouter,
    };
    const gasLimit = await this.interchainAccountApp.estimateIcaHandleGas({
      origin: this.config.chain,
      destination: this.config.destinationChain,
      innerCalls,
      config: icaConfig,
    });
    const hookMetadata = formatStandardHookMetadata({
      refundAddress,
      gasLimit: gasLimit.toBigInt(),
    });

    const icaTx = await this.interchainAccountApp.getCallRemote({
      chain: this.config.chain,
      destination: this.config.destinationChain,
      innerCalls,
      config: icaConfig,
      hookMetadata,
    });

    return this.submitter.submit({
      chainId: this.multiProvider.getDomainId(this.config.chain),
      ...icaTx,
      // callRemote derives the ICA from msg.sender, so `from` must be the owner (not the
      // populating signer) for file output to be self-describing. Live submitters are
      // unaffected: MultiProvider.sendTransaction calls prepareTx with no `from`, which
      // overwrites tx.from with getSignerAddress(chain).
      from: bytes32ToAddress(this.config.owner),
    });
  }
}
