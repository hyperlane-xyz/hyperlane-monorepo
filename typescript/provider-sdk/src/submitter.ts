import { AnnotatedTx, TxReceipt } from './module.js';

export interface TransactionSubmitterConfigs {
  jsonRpc: JsonRpcSubmitterConfig;
  file: FileSubmitterConfig;
}

export type TransactionSubmitterType = keyof TransactionSubmitterConfigs;
export type TransactionSubmitterConfig =
  TransactionSubmitterConfigs[TransactionSubmitterType];

interface BaseSubmitterConfig<T extends keyof TransactionSubmitterConfigs> {
  type: T;
  chain: string;
}

export interface JsonRpcSubmitterConfig extends BaseSubmitterConfig<'jsonRpc'> {
  privateKey: string;
  accountAddress?: string;
}

export interface FileSubmitterConfig extends BaseSubmitterConfig<'file'> {
  filepath: string;
}

export interface ITransactionSubmitter {
  submit(...transactions: AnnotatedTx[]): Promise<TxReceipt[]>;
}
