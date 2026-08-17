import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { IImpersonatingSigner, ISigner } from './altvm.js';
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
   * The account being impersonated, mirroring the account anvil impersonates
   * for the EVM impersonated submitter. The Sealevel implementation pays fees
   * from a fixed fork-only account and leaves this account's signature slot
   * empty, but scopes impersonation to it: a transaction requiring a signature
   * from any other account is rejected.
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

abstract class BaseAltVMJsonRpcSubmitter implements ITransactionSubmitter {
  // Each concrete leaf pins its own literal. The union includes the released
  // JsonRpc value `'jsonRPC'` (not a TransactionSubmitterType member, preserved
  // for external discrimination) so a subclass can't introduce an arbitrary one.
  public abstract readonly txSubmitterType:
    | TransactionSubmitterType
    | 'jsonRPC';

  protected readonly logger: Logger;

  constructor(
    public readonly signer: ISigner<AnnotatedTx, TxReceipt>,
    public readonly config: { chain: string },
  ) {
    this.logger = rootLogger.child({
      module: this.constructor.name,
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

export class AltVMJsonRpcSubmitter extends BaseAltVMJsonRpcSubmitter {
  public readonly txSubmitterType = 'jsonRPC' as const;
}

// Submission behavior is the base's; this subclass only requires an
// impersonating signer and labels itself with the impersonated discriminant.
export class AltVMImpersonatedSubmitter extends BaseAltVMJsonRpcSubmitter {
  public readonly txSubmitterType: typeof SubmitterType.ImpersonatedAccount =
    SubmitterType.ImpersonatedAccount;

  constructor(
    signer: IImpersonatingSigner<AnnotatedTx, TxReceipt>,
    config: { chain: string },
  ) {
    super(signer, config);
  }
}
