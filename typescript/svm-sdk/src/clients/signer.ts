import type { TransactionSigner } from '@solana/kit';

import type { SvmReceipt, SvmTransaction } from '../types.js';

export interface SvmSignerClient {
  signer: TransactionSigner;
  send(transaction: SvmTransaction): Promise<SvmReceipt>;
}
