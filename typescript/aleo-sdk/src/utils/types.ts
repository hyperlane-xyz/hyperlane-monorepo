import { ConfirmedTransactionJSON, ExecuteOptions } from '@provablehq/sdk';

export interface AleoTransaction extends ExecuteOptions {}
export interface AleoReceipt extends ConfirmedTransactionJSON {
  transactionHash: string;
}
