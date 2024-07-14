import { TransactionReceipt } from '@ethersproject/providers';
import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { PopulatedTransactions } from '../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';

export class EV5JsonRpcTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(public readonly multiProvider: MultiProvider) {}

  public async submit(
    ...txs: PopulatedTransactions
  ): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = [];
    for (const tx of txs) {
      assert(tx.chainId, 'Invalid PopulatedTransaction: Missing chainId field');
      const txChain = this.multiProvider.getChainName(tx.chainId);
      const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
        txChain,
        tx,
      );
      this.logger.debug(
        `Submitted PopulatedTransaction on ${txChain}: ${receipt.transactionHash}`,
      );
      receipts.push(receipt);
    }
    return receipts;
  }
}
