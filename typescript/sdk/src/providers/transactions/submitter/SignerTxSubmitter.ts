import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';

import { TxSubmitterInterface } from './TxSubmitter.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';

export class SignerTxSubmitter<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> implements TxSubmitterInterface<HTX, HTR>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.SIGNER;

  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  public async submitTxs(hyperlaneTxs: HTX[]): Promise<HTR[]> {
    const hyperlaneReceipts: HTR[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const hyperlaneReceipt = await this.submitTx(hyperlaneTx);
      hyperlaneReceipts.push(hyperlaneReceipt);
    }
    return hyperlaneReceipts;
  }

  public async submitTx(hyperlaneTx: HTX): Promise<HTR> {
    const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx,
    );

    this.logger.debug(
      `Submitted SignerHyperlaneTx on ${this.chain}: ${receipt.transactionHash}`,
    );

    return receipt as HTR;
  }
}
