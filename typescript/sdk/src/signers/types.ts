import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { Address } from '@hyperlane-xyz/utils';

import { ProtocolTypedTransaction } from '../providers/ProviderType.js';

export interface IMultiProtocolSigner<TProtocol extends ProtocolType> {
  address(): Promise<Address>;
  sendAndConfirmTransaction(
    tx: ProtocolTypedTransaction<TProtocol>,
  ): Promise<string>;
}
