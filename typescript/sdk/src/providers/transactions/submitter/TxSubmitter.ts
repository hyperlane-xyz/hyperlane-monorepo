import { TransactionReceipt } from '@ethersproject/providers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';

export enum TxSubmitterType {
  DEFAULT /* Default submitter */,
  SIGNER /* Private key submitter */,
  IMPERSONATED_ACCOUNT /* Impersonated account submitter */,
  GNOSIS_SAFE /* Gnosis Safe submitter */,
  ICA /* Interchain Account submitter */, // TODO: Add
  // RETRY /* Retry submitter */ // TODO: Discuss
}

export interface TxSubmitterInterface<HTX extends HyperlaneTx> {
  /**
   * Defines the type of tx submitter
   */
  txSubmitterType: TxSubmitterType;
  /**
   * Should execute all hyperlane txs and return their tx receipts
   * @param hyperlaneTxs The array of hyperlane txs to execute
   */
  sendTxs(hyperlaneTxs: HTX[]): Promise<TransactionReceipt[]>;
  /**
   * Should execute a hyperlane tx and return its tx receipt
   * @param hyperlaneTx The hyperlane tx to execute
   */
  sendTx(hyperlaneTx: HTX): Promise<TransactionReceipt>;
}

export class TxSubmitter implements TxSubmitterInterface<HyperlaneTx> {
  constructor(
    public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.DEFAULT,
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  public async sendTxs(
    hyperlaneTxs: HyperlaneTx[],
  ): Promise<TransactionReceipt[]> {
    const txReceipts: TransactionReceipt[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.sendTx(hyperlaneTx);
      txReceipts.push(receipt);
    }
    return txReceipts;
  }

  public async sendTx(hyperlaneTx: HyperlaneTx): Promise<TransactionReceipt> {
    return await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx.populatedTx,
    );
  }
}
