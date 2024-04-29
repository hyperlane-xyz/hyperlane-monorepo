import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  EthersV5Transaction,
  EthersV5TransactionReceipt,
  ProviderType,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitter.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class JsonRpcTxSubmitter
  implements
    TxSubmitterInterface<EthersV5Transaction, EthersV5TransactionReceipt>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {}

  public async submitTxs(
    txs: EthersV5Transaction[],
  ): Promise<EthersV5TransactionReceipt[]> {
    const receipts: EthersV5TransactionReceipt[] = [];
    for (const tx of txs) {
      const receipt = await this.submitTx(tx);
      receipts.push(receipt);
    }
    return receipts;
  }

  public async submitTx(
    tx: EthersV5Transaction,
  ): Promise<EthersV5TransactionReceipt> {
    const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
      this.chain,
      tx.transaction,
    );

    this.logger.debug(
      `Submitted EthersV5Transaction on ${this.chain}: ${receipt.transactionHash}`,
    );

    return { type: ProviderType.EthersV5, receipt };
  }
}
