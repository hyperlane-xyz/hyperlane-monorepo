import { ethers } from 'ethers';
import { Logger } from 'pino';

import { CallData, assert, rootLogger } from '@hyperlane-xyz/utils';

import { getInterchainAccount } from '../../../../middleware/account/InterchainAccount.js';
import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { PopulatedTransaction } from '../../types.js';
import { TxTransformerType } from '../TxTransformerTypes.js';

import { EV5TxTransformerInterface } from './EV5TxTransformerInterface.js';
import { EV5InterchainAccountTxTransformerProps } from './EV5TxTransformerTypes.js';

export class EV5InterchainAccountTxTransformer
  implements EV5TxTransformerInterface
{
  public readonly txTransformerType: TxTransformerType = TxTransformerType.ICA;
  protected readonly logger: Logger = rootLogger.child({
    module: 'ica-transformer',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5InterchainAccountTxTransformerProps,
  ) {}

  public async transform(
    ...txs: PopulatedTransaction[]
  ): Promise<ethers.PopulatedTransaction[]> {
    const txChainsToInnerCalls: Record<ChainName, CallData[]> = {};

    txs.map(({ to, data, value, chainId }: PopulatedTransaction) => {
      const txChain = this.multiProvider.getChainName(chainId);
      if (!txChainsToInnerCalls[txChain]) txChainsToInnerCalls[txChain] = [];
      txChainsToInnerCalls[txChain].push({ to, data, value });
    });

    assert(
      this.props.config.localRouter,
      'Invalid AccountConfig: Cannot retrieve InterchainAccount.',
    );

    const interchainAccount = getInterchainAccount(
      this.multiProvider,
      this.props.chain,
      this.props.config,
    );

    const transformedTxs: Promise<ethers.PopulatedTransaction>[] = [];
    Object.keys(txChainsToInnerCalls).map((txChain: ChainName) => {
      const transformedTx = interchainAccount.getCallRemote({
        chain: this.props.chain,
        destination: txChain,
        innerCalls: txChainsToInnerCalls[txChain],
        config: this.props.config,
        hookMetadata: this.props.hookMetadata,
      });
      transformedTxs.push(transformedTx);
    });

    return Promise.all(transformedTxs);
  }
}
