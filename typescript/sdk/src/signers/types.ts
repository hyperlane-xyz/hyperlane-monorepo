import { type Address, type ProtocolType } from '@hyperlane-xyz/utils';

import { type ProtocolTypedTransaction } from '../providers/ProviderType.js';

export interface IMultiProtocolSigner<TProtocol extends ProtocolType> {
  address(): Promise<Address>;
  sendAndConfirmTransaction(
    tx: ProtocolTypedTransaction<TProtocol>,
  ): Promise<string>;
}
