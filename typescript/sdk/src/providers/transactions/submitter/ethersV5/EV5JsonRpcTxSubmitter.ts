import { type TransactionReceipt } from '@ethersproject/providers';
import { type ContractReceipt } from 'ethers';
import { type Logger } from 'pino';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { type MultiProvider } from '../../../MultiProvider.js';
import { type AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { type EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';
import { type EV5JsonRpcTxSubmitterProps } from './types.js';

export class EV5JsonRpcTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5JsonRpcTxSubmitterProps,
  ) {}

  public async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = [];
    const submitterChainId = this.multiProvider.getChainId(this.props.chain);
    for (const tx of txs) {
      assert(tx.chainId, 'Invalid PopulatedTransaction: Missing chainId field');
      assert(
        tx.chainId === submitterChainId,
        `Transaction chainId ${tx.chainId} does not match submitter chainId ${submitterChainId}`,
      );
      const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
        this.props.chain,
        tx,
      );
      this.logger.debug(
        `Submitted PopulatedTransaction on ${this.props.chain}: ${receipt.transactionHash}`,
      );
      receipts.push(receipt);
    }
    return receipts;
  }
}
