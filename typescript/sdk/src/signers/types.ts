import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { SendTransactionOptions } from '../providers/MultiProvider.js';
import { ProtocolTypedTransaction } from '../providers/ProviderType.js';

export interface IMultiProtocolSigner<TProtocol extends ProtocolType> {
  address(): Promise<Address>;
  sendAndConfirmTransaction(
    tx: ProtocolTypedTransaction<TProtocol>,
    options?: SendTransactionOptions,
  ): Promise<string>;
}
