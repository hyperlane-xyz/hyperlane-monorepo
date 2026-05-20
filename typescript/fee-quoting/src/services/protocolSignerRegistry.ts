import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import type { IProtocolQuoteSigner } from './IProtocolQuoteSigner.js';

/**
 * Dispatcher from `ProtocolType` → `IProtocolQuoteSigner`. Built once at
 * server startup and consulted on every v2 quote request. Throws on unknown
 * protocols — `QuoteService` is expected to only insert chain contexts whose
 * protocol has a registered signer.
 */
export class ProtocolSignerRegistry {
  constructor(
    private readonly signers: Map<ProtocolType, IProtocolQuoteSigner>,
  ) {}

  forProtocol(protocol: ProtocolType): IProtocolQuoteSigner {
    const signer = this.signers.get(protocol);
    assert(signer, `No quote signer registered for protocol ${protocol}`);
    return signer;
  }

  has(protocol: ProtocolType): boolean {
    return this.signers.has(protocol);
  }
}
