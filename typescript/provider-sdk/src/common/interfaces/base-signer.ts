export interface IBaseSigner<T, R> {
  getSignerAddress(): string;

  supportsTransactionBatching(): boolean;

  transactionToPrintableJson(transaction: T): Promise<object>;

  sendAndConfirmTransaction(transaction: T): Promise<R>;

  sendAndConfirmBatchTransactions(transactions: T[]): Promise<R>;

  getAddressFromReceipt(receipt: R): Promise<string>;
}
