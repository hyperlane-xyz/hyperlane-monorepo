import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { InterchainAccountHyperlaneTx } from '../InterchainAccountHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class InterchainAccountTxTransformer
  implements TxTransformerInterface<InterchainAccountHyperlaneTx>
{
  public readonly txTransformerType: TxTransformerType = TxTransformerType.ICA;
  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
  ): Promise<InterchainAccountHyperlaneTx[]> {
    const txs: InterchainAccountHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<InterchainAccountHyperlaneTx> {
    this.logger.debug('Transforming to InterchainAccountHyperlaneTx...');
    // TODO: Transform to GnosisSafeHyperlaneTx w/ different 'to' set ?
    return new InterchainAccountHyperlaneTx(populatedTx);
  }
}
