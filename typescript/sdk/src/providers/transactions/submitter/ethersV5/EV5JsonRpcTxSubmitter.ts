import { TransactionReceipt } from '@ethersproject/providers';
import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';

export class EV5JsonRpcTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(public readonly multiProvider: MultiProvider) {}

  public async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = [];
    for (const tx of txs) {
      const txChain = this.multiProvider.getChainName(tx.chain);
      const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
        txChain,
        tx,
      );
      this.logger.debug(
        `Submitted populated transaction on ${txChain}: ${receipt.transactionHash}`,
      );
      receipts.push(receipt);
    }
    return receipts;
  }
}
