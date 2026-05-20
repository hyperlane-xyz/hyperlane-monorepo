import { NoQuoteAvailableReason } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { NoQuoteAvailableError } from '../middleware/errorHandler.js';

import type { IProtocolQuoteService } from './IProtocolQuoteService.js';

/**
 * Dispatcher from `ProtocolType` → `IProtocolQuoteService`. Built once at
 * server startup and consulted on every v2 quote request. Lookups for a
 * protocol with no registered signer throw `NoQuoteAvailableError` (404
 * `NotConfigured`) so partially-rolled-out protocols return a clean v2 body
 * instead of a 500.
 */
export class ProtocolSignerRegistry {
  constructor(
    private readonly signers: Map<ProtocolType, IProtocolQuoteService>,
  ) {}

  forProtocol(protocol: ProtocolType): IProtocolQuoteService {
    const signer = this.signers.get(protocol);
    if (!signer) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `No quote signer registered for protocol ${protocol}`,
      );
    }
    return signer;
  }

  has(protocol: ProtocolType): boolean {
    return this.signers.has(protocol);
  }
}
