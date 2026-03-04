import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { ProtocolTypedTransaction } from '../providers/ProviderType.js';

export interface SignerSendTransactionOptions {
  /** Number of confirmations to wait for. EVM: passed to MultiProvider. Other protocols: ignored. */
  waitConfirmations?: number;
}

export interface IMultiProtocolSigner<TProtocol extends ProtocolType> {
  address(): Promise<Address>;
  sendAndConfirmTransaction(
    tx: ProtocolTypedTransaction<TProtocol>,
    options?: SignerSendTransactionOptions,
  ): Promise<string>;
}
