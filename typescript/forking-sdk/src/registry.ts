import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { ForkManagerFactory } from './types.js';

/**
 * Registry for managing fork manager factories, keyed by protocol.
 */
export class ForkManagerRegistry {
  private protocols = new Map<ProtocolType, ForkManagerFactory>();

  hasProtocol(protocol: ProtocolType): boolean {
    return this.protocols.has(protocol);
  }

  listProtocols(): ProtocolType[] {
    return Array.from(this.protocols.keys());
  }

  registerProtocol(protocol: ProtocolType, factory: ForkManagerFactory): void {
    assert(
      !this.hasProtocol(protocol),
      `Protocol '${protocol}' is already registered`,
    );

    this.protocols.set(protocol, factory);
  }

  getForkManagerFactory(protocol: ProtocolType): ForkManagerFactory {
    const factory = this.protocols.get(protocol);
    assert(
      factory,
      `Protocol '${protocol}' is not registered. Available protocols: ${this.listProtocols().join(', ') || 'none'}`,
    );

    return factory;
  }
}
