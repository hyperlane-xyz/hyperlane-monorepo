import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { ISigner } from './altvm.js';
import { AnnotatedTx, TxReceipt } from './module.js';

export const SubmitterType = {
  JsonRpc: 'jsonRpc',
  ImpersonatedAccount: 'impersonatedAccount',
  File: 'file',
} as const;

export interface TransactionSubmitterConfigs {
  jsonRpc: JsonRpcSubmitterConfig;
  impersonatedAccount: ImpersonatedAccountSubmitterConfig;
  file: FileSubmitterConfig;
}

export type TransactionSubmitterType = keyof TransactionSubmitterConfigs;
export type TransactionSubmitterConfig =
  TransactionSubmitterConfigs[TransactionSubmitterType];

interface BaseSubmitterConfig<T extends keyof TransactionSubmitterConfigs> {
  type: T;
  chain: string;
}

export interface JsonRpcSubmitterConfig extends BaseSubmitterConfig<
  typeof SubmitterType.JsonRpc
> {
  privateKey: string;
  accountAddress?: string;
}

export interface ImpersonatedAccountSubmitterConfig extends BaseSubmitterConfig<
  typeof SubmitterType.ImpersonatedAccount
> {
  /**
   * The account being impersonated. Required for parity with the EVM
   * impersonated submitter, where it is the account anvil impersonates. The
   * Sealevel implementation pays fees from a fixed fork-only account and leaves
   * the owner's signature slot empty, so it does not consume this field.
   */
  userAddress: string;
}

export interface FileSubmitterConfig extends BaseSubmitterConfig<
  typeof SubmitterType.File
> {
  filepath: string;
}

export interface ITransactionSubmitter {
  submit(...transactions: AnnotatedTx[]): Promise<TxReceipt[]>;
}

export class AltVMJsonRpcSubmitter implements ITransactionSubmitter {
  public readonly txSubmitterType: string = 'jsonRPC';

  protected readonly logger: Logger = rootLogger.child({
    module: 'AltVMJsonRpcSubmitter',
  });

  constructor(
    public readonly signer: ISigner<AnnotatedTx, TxReceipt>,
    public readonly config: { chain: string },
  ) {
    this.logger = rootLogger.child({
      module: AltVMJsonRpcSubmitter.name,
    });
  }

  public async submit(...txs: AnnotatedTx[]): Promise<TxReceipt[]> {
    if (txs.length === 0) {
      return [];
    }

    if (this.signer.supportsTransactionBatching()) {
      for (const tx of txs) {
        if (tx.annotation) {
          this.logger.info(tx.annotation);
        }
      }
      const receipt = await this.signer.sendAndConfirmBatchTransactions(txs);
      return [receipt];
    }

    const receipts: TxReceipt[] = [];

    for (const tx of txs) {
      if (tx.annotation) {
        this.logger.info(tx.annotation);
      }

      const receipt = await this.signer.sendAndConfirmTransaction(tx);
      receipts.push(receipt);
    }

    return receipts;
  }
}

/**
 * Submits AltVM transactions through an impersonating signer that partially
 * signs (only with the held key) and relies on a fork's disabled signature
 * verification to land transactions whose real authority key is not held.
 *
 * All submission behavior is inherited from {@link AltVMJsonRpcSubmitter}; the
 * impersonation lives entirely in the injected signer. This subclass exists to
 * label the submission accurately.
 */
export class AltVMImpersonatedSubmitter extends AltVMJsonRpcSubmitter {
  public override readonly txSubmitterType: string = 'impersonatedAccount';
}
