import { z } from 'zod';

import { ProtocolType, assert } from '@hyperlane-xyz/utils';

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
import { EV5JsonRpcTxSubmitter } from './ethersV5/EV5JsonRpcTxSubmitter.js';
import { EvmIcaTxSubmitterPropsSchema } from './ethersV5/schemas.js';

const EvmIcaTxSubmitterConfigSchema = EvmIcaTxSubmitterPropsSchema.required({
  originInterchainAccountRouter: true,
});

/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
const EvmIcaTxSubmitterConstructorConfigSchema =
  EvmIcaTxSubmitterConfigSchema.omit({ internalSubmitter: true }).required({
    owner: true,
  });

type EvmIcaTxSubmitterConfig = z.infer<typeof EvmIcaTxSubmitterConfigSchema>;
type EvmIcaTxSubmitterConstructorConfig = z.infer<
  typeof EvmIcaTxSubmitterConstructorConfigSchema
>;

function getInternalSubmitter(
  chain: ChainName,
  multiProvider: MultiProvider,
  config: EvmIcaTxSubmitterConfig['internalSubmitter'],
): TxSubmitterInterface<ProtocolType.Ethereum> {
  const internalSubmitterMap: Record<
    EvmIcaTxSubmitterConfig['internalSubmitter']['type'],
    () => TxSubmitterInterface<ProtocolType.Ethereum>
  > = {
    [TxSubmitterType.GNOSIS_SAFE]: () => {
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        chain,
        ...config,
      });
    },
    [TxSubmitterType.GNOSIS_TX_BUILDER]: () => {
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        chain,
        ...config,
      });
    },
    [TxSubmitterType.IMPERSONATED_ACCOUNT]: () => {
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        chain,
        ...config,
      });
    },
    [TxSubmitterType.JSON_RPC]: () => {
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        chain,
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

  return internalSubmitterFactory();
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
    const internalSubmitter = getInternalSubmitter(
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

    // TODO: add checks to verify that the ica can send the txs on the destination chain
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
