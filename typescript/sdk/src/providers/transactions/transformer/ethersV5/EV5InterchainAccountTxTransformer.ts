import { ethers } from 'ethers';
import { Logger } from 'pino';

import { assert, objKeys, rootLogger } from '@hyperlane-xyz/utils';

import {
  InterchainAccount,
  buildInterchainAccountApp,
} from '../../../../middleware/account/InterchainAccount.js';
import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { CallData, PopulatedTransaction } from '../../types.js';
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
    ...txs: PopulatedTransaction[]
  ): Promise<ethers.PopulatedTransaction[]> {
    const txChainsToInnerCalls: Record<ChainName, CallData[]> = txs.reduce(
      (
        txChainToInnerCalls: Record<ChainName, CallData[]>,
        { to, data, chainId }: PopulatedTransaction,
      ) => {
        const txChain = this.multiProvider.getChainName(chainId);
        txChainToInnerCalls[txChain] ||= [];
        txChainToInnerCalls[txChain].push({ to, data });
        return txChainToInnerCalls;
      },
      {},
    );

    const interchainAccountApp: InterchainAccount = buildInterchainAccountApp(
      this.multiProvider,
      this.props.chain,
      this.props.config,
    );

    const transformedTxs: ethers.PopulatedTransaction[] = [];
    for (const txChain of objKeys(txChainsToInnerCalls)) {
      transformedTxs.push(
        await interchainAccountApp.getCallRemote({
          chain: this.props.chain,
          destination: txChain,
          innerCalls: txChainsToInnerCalls[txChain],
          config: this.props.config,
          hookMetadata: this.props.hookMetadata,
        }),
      );
    }

    return transformedTxs;
  }
}
