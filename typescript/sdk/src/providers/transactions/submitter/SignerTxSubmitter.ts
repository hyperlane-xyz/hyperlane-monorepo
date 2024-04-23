import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';
import { SignerHyperlaneTx } from '../SignerHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class SignerTxSubmitter
  implements TxSubmitterInterface<SignerHyperlaneTx, HyperlaneTxReceipt>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.SIGNER;
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

  public async submitTxs(
    hyperlaneTxs: SignerHyperlaneTx[],
  ): Promise<HyperlaneTxReceipt[]> {
    const hyperlaneReceipts: HyperlaneTxReceipt[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.submitTx(hyperlaneTx);
      hyperlaneReceipts.push(receipt);
    }
    return hyperlaneReceipts;
  }

  public async submitTx(
    hyperlaneTx: SignerHyperlaneTx,
  ): Promise<HyperlaneTxReceipt> {
    const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx.populatedTx,
    );

    this.logger.debug(
      `Submitted SignerHyperlaneTx on ${this.chain}: ${receipt.transactionHash}`,
    );

    return receipt;
  }
}
