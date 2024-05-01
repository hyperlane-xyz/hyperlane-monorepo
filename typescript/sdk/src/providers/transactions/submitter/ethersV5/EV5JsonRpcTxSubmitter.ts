import { TransactionReceipt } from '@ethersproject/providers';
import { ContractReceipt, PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';

export class EV5JsonRpcTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {}

  public async submit(
    ...txs: PopulatedTransaction[]
  ): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = [];
    for (const tx of txs) {
      const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
        this.chain,
        tx,
      );
      this.logger.debug(
        `Submitted PopulatedTransaction on ${this.chain}: ${receipt.transactionHash}`,
      );
      receipts.push(receipt);
    }
    return receipts;
  }
}
