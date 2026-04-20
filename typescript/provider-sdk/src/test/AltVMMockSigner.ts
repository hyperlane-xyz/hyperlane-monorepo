import * as AltVM from '../altvm.js';

import { MockProvider } from './AltVMMockProvider.js';

type MockTransaction = any;
type MockReceipt = any;

export class MockSigner
  extends MockProvider
  implements AltVM.ISigner<MockTransaction, MockReceipt>
{
  static async connectWithSigner(): Promise<
    AltVM.ISigner<MockTransaction, MockReceipt>
  > {
    return new MockSigner();
  }

  getSignerAddress(): string {
    throw new Error(`not implemented`);
  }

  supportsTransactionBatching(): boolean {
    throw new Error(`not implemented`);
  }

  async transactionToPrintableJson(
    _transaction: MockTransaction,
  ): Promise<object> {
    throw new Error(`not implemented`);
  }

  async sendAndConfirmTransaction(
    _transaction: MockTransaction,
  ): Promise<MockReceipt> {
    throw new Error(`not implemented`);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: MockTransaction[],
  ): Promise<MockReceipt> {
    throw new Error(`not implemented`);
  }
}
