import { TransactionReceipt } from '@ethersproject/providers';
import { ContractReceipt, Signer } from 'ethers';
import { Logger } from 'pino';

import { assert, formatError, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';
import { EV5JsonRpcTxSubmitterProps } from './types.js';

export interface EV5SubmittedTransaction {
  transactionHash: string;
  receipt?: TransactionReceipt;
}

/** Retains irreversible progress when a sequential batch fails. */
export class EV5JsonRpcSubmissionError extends Error {
  readonly name = 'EV5JsonRpcSubmissionError';

  constructor(
    message: string,
    public readonly submittedTransactions: EV5SubmittedTransaction[],
    public readonly cause: unknown,
  ) {
    super(message);
  }
}

export class EV5JsonRpcTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5JsonRpcTxSubmitterProps,
    public readonly signer?: Signer,
  ) {}

  public async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<TransactionReceipt[]> {
    const receipts: TransactionReceipt[] = [];
    const submittedTransactions: EV5SubmittedTransaction[] = [];
    const submitterChainId = this.multiProvider.getChainId(this.props.chain);

    // Validate the entire batch before the first irreversible broadcast.
    for (const tx of txs) {
      assert(tx.chainId, 'Invalid PopulatedTransaction: Missing chainId field');
      assert(
        tx.chainId === submitterChainId,
        `Transaction chainId ${tx.chainId} does not match submitter chainId ${submitterChainId}`,
      );
    }

    const provider = this.multiProvider.getProvider(this.props.chain);
    const signer = this.signer
      ? this.signer.provider === provider
        ? this.signer
        : this.signer.connect(provider)
      : this.multiProvider.getSigner(this.props.chain);
    const signerAddress = await signer.getAddress();

    for (const tx of txs) {
      try {
        const { annotation, ...populatedTx } = tx;
        if (annotation) this.logger.info(annotation);

        const txRequest = await this.multiProvider.prepareTx(
          this.props.chain,
          populatedTx,
          signerAddress,
        );
        const response = await signer.sendTransaction(txRequest);
        const submittedTransaction: EV5SubmittedTransaction = {
          transactionHash: response.hash,
        };
        submittedTransactions.push(submittedTransaction);
        this.logger.info(`Sent tx ${response.hash}`);

        const receipt: ContractReceipt = await this.multiProvider.handleTx(
          this.props.chain,
          response,
        );
        submittedTransaction.receipt = receipt;
        assert(
          receipt.status === 1,
          `Transaction ${receipt.transactionHash} reverted`,
        );
        this.logger.debug(
          `Submitted PopulatedTransaction on ${this.props.chain}: ${receipt.transactionHash}`,
        );
        receipts.push(receipt);
      } catch (error) {
        throw new EV5JsonRpcSubmissionError(
          `Failed to submit JSON-RPC transaction batch on ${this.props.chain}: ${formatError(error)}`,
          submittedTransactions,
          error,
        );
      }
    }

    return receipts;
  }
}
