import { PopulatedTransaction } from 'ethers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';

export enum TxTransformerType {
  DEFAULT /* Default transformer */,
  SIGNER /* Private key transformer */,
  IMPERSONATED_ACCOUNT /* Impersonated account transformer */,
  GNOSIS_SAFE /* Gnosis Safe transformer */,
  ICA /* Interchain Account transformer */, // TODO: Add
}

export interface TxTransformerInterface<HTX extends HyperlaneTx> {
  /**
   * Defines the type of tx transformer
   */
  txTransformerType: TxTransformerType;

  /**
   * Should transform all populated txs into HyperlaneTransactions
   * @param populatedTxs The array of populated txs to transform
   */
  transformTxs(
    populatedTxs: PopulatedTransaction[],
    props?: any,
  ): Promise<HTX[]>;

  /**
   * Should transform a populated tx into a HyperlaneTransaction
   * @param populatedTx The populated tx to transform
   */
  transformTx(populatedTx: PopulatedTransaction, props?: any): Promise<HTX>;
}

export class TxTransformer implements TxTransformerInterface<HyperlaneTx> {
  constructor(
    public readonly txTransformerType: TxTransformerType = TxTransformerType.DEFAULT,
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
  ): Promise<HyperlaneTx[]> {
    const txs: HyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<HyperlaneTx> {
    return new HyperlaneTx(populatedTx);
  }
}
