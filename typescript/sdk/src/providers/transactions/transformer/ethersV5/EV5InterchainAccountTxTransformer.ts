import { Logger } from 'pino';

import { assert, objMap, rootLogger } from '@hyperlane-xyz/utils';

import {
  InterchainAccount,
  buildInterchainAccountApp,
} from '../../../../middleware/account/InterchainAccount.js';
import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { CallData } from '../../types.js';
import { TxTransformerType } from '../TxTransformerTypes.js';

import { EV5TxTransformerInterface } from './EV5TxTransformerInterface.js';
import { EV5InterchainAccountTxTransformerProps } from './types.js';

export class EV5InterchainAccountTxTransformer
  implements EV5TxTransformerInterface
{
  public readonly txTransformerType: TxTransformerType =
    TxTransformerType.INTERCHAIN_ACCOUNT;
  protected readonly logger: Logger = rootLogger.child({
    module: 'ica-transformer',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5InterchainAccountTxTransformerProps,
  ) {
    assert(
      this.props.config.localRouter,
      'Invalid AccountConfig: Cannot retrieve InterchainAccount.',
    );
  }

  public async transform(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<AnnotatedEV5Transaction[]> {
    const transformerChainId = this.multiProvider.getChainId(this.props.chain);
    const txChainsToInnerCalls: Record<ChainName, CallData[]> = txs.reduce(
      (
        txChainToInnerCalls: Record<ChainName, CallData[]>,
        { to, data, chainId }: AnnotatedEV5Transaction,
      ) => {
        assert(chainId, 'Invalid PopulatedTransaction: "chainId" is required');
        assert(to, 'Invalid PopulatedTransaction: "to" is required');
        assert(data, 'Invalid PopulatedTransaction: "data" is required');
        assert(
          chainId === transformerChainId,
          `Transaction chainId ${chainId} does not match transformer chainId ${transformerChainId}`,
        );
        txChainToInnerCalls[chainId] ||= [];
        txChainToInnerCalls[chainId].push({ to, data });
        return txChainToInnerCalls;
      },
      {},
    );

    const interchainAccountApp: InterchainAccount = buildInterchainAccountApp(
      this.multiProvider,
      this.props.chain,
      this.props.config,
    );

    const transformedTxs: AnnotatedEV5Transaction[] = [];
    objMap(txChainsToInnerCalls, async (destination, innerCalls) => {
      transformedTxs.push(
        await interchainAccountApp.getCallRemote({
          chain: this.props.chain,
          destination,
          innerCalls,
          config: this.props.config,
          hookMetadata: this.props.hookMetadata,
        }),
      );
    });

    return transformedTxs;
  }
}
