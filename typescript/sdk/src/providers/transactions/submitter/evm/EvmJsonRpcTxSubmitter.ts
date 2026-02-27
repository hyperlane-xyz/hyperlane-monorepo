import { TransactionReceipt } from 'ethers';
import { Logger } from 'pino';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEvmTransaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EvmTxSubmitterInterface } from './EvmTxSubmitterInterface.js';
import { EvmJsonRpcTxSubmitterProps } from './types.js';

export class EvmJsonRpcTxSubmitter implements EvmTxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EvmJsonRpcTxSubmitterProps,
  ) {}

  public async submit(
    ...txs: AnnotatedEvmTransaction[]
  ): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = [];
    const submitterChainId = this.multiProvider.getChainId(this.props.chain);
    for (const tx of txs) {
      assert(tx.chainId, 'Invalid PopulatedTransaction: Missing chainId field');
      assert(
        tx.chainId === submitterChainId,
        `Transaction chainId ${tx.chainId} does not match submitter chainId ${submitterChainId}`,
      );
      const receipt: TransactionReceipt =
        await this.multiProvider.sendTransaction(this.props.chain, tx);
      this.logger.debug(
        `Submitted PopulatedTransaction on ${this.props.chain}: ${receipt.hash}`,
      );
      receipts.push(receipt);
    }
    return receipts;
  }
}
