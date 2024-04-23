import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { SignerHyperlaneTx } from '../SignerHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class SignerTxTransformer
  implements TxTransformerInterface<SignerHyperlaneTx>
{
  public readonly txTransformerType: TxTransformerType =
    TxTransformerType.SIGNER;
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
  ): Promise<SignerHyperlaneTx[]> {
    const txs: SignerHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<SignerHyperlaneTx> {
    this.logger.debug('Transforming to SignerHyperlaneTx...');
    return new SignerHyperlaneTx(populatedTx);
  }
}
