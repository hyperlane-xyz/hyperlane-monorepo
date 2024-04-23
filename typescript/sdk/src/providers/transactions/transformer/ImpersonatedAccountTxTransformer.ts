import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { ImpersonatedAccountHyperlaneTx } from '../ImpersonatedAccountHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class ImpersonatedAccountTxTransformer
  implements TxTransformerInterface<ImpersonatedAccountHyperlaneTx>
{
  public readonly txTransformerType: TxTransformerType =
    TxTransformerType.IMPERSONATED_ACCOUNT;
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
  ): Promise<ImpersonatedAccountHyperlaneTx[]> {
    const txs: ImpersonatedAccountHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<ImpersonatedAccountHyperlaneTx> {
    this.logger.debug('Transforming to ImpersonatedAccountHyperlaneTx...');
    return new ImpersonatedAccountHyperlaneTx(populatedTx);
  }
}
