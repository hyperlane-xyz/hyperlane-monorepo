import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { CallData, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
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
  ): Promise<PopulatedTransaction[]> {
    const txChainsToInnerCalls: Record<ChainName, CallData[]> = {};

    txs.map(({ to, data, value, chainId }: PopulatedTransaction) => {
      assert(to, 'Invalid PopulatedTransaction: Missing to field');
      assert(data, 'Invalid PopulatedTransaction: Missing data field');
      assert(chainId, 'Invalid PopulatedTransaction: Missing chainId field');
      const txChain = this.multiProvider.getChainName(chainId);
      if (!txChainsToInnerCalls[txChain]) txChainsToInnerCalls[txChain] = [];
      txChainsToInnerCalls[txChain].push({ to, data, value });
    });

    const transformedTxs: Promise<PopulatedTransaction>[] = [];
    Object.keys(txChainsToInnerCalls).map((txChain: ChainName) => {
      transformedTxs.push(
        this.props.interchainAccount.getCallRemote(
          this.props.chain,
          txChain,
          txChainsToInnerCalls[txChain],
          this.props.accountConfig,
          this.props.hookMetadata,
        ),
      );
    });

    return Promise.all(transformedTxs);
  }
}
