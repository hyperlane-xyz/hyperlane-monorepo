import type { TransactionSigner } from '@solana/kit';

import type { SvmReceipt, SvmTransaction } from './types.js';

export interface SvmSigner {
  signer: TransactionSigner;
  send(transaction: SvmTransaction): Promise<SvmReceipt>;
}
