import { assert } from '@hyperlane-xyz/utils';

import { ProtocolProvider } from './factory.js';
import { ProtocolType } from './protocol.js';

/**
 * Internal registry for managing protocol providers.
 */
class ProtocolProviderRegistry {
  private protocols = new Map<ProtocolType, () => ProtocolProvider>();

  hasProtocol(protocol: ProtocolType): boolean {
    return this.protocols.has(protocol);
  }

  listProtocols(): ProtocolType[] {
    return Array.from(this.protocols.keys());
  }

  registerProtocol(
    protocol: ProtocolType,
    factory: () => ProtocolProvider,
  ): void {
    assert(
      !this.hasProtocol(protocol),
      `Protocol '${protocol}' is already registered`,
    );

    this.protocols.set(protocol, factory);
  }

  getProtocolProvider(protocol: ProtocolType): ProtocolProvider {
    const factory = this.protocols.get(protocol);
    assert(
      factory,
      `Protocol '${protocol}' is not registered. Available protocols: ${this.listProtocols().join(', ') || 'none'}`,
    );

    return factory();
  }
}

// Singleton registry instance
const protocolRegistry = new ProtocolProviderRegistry();

/**
 * Register a protocol provider implementation.
 *
 * @param protocol The protocol type to register
 * @param factory Factory function that creates a ProtocolProvider instance
 */
export const registerProtocol =
  protocolRegistry.registerProtocol.bind(protocolRegistry);

/**
 * Get a protocol provider instance by protocol type.
 *
 * @param protocol The protocol type (e.g., ProtocolType.Ethereum, ProtocolType.Sealevel, ProtocolType.Radix)
 * @returns A new {@link ProtocolProvider} instance
 * @throws Error if the protocol is not registered
 */
export const getProtocolProvider =
  protocolRegistry.getProtocolProvider.bind(protocolRegistry);

/**
 * Check if a protocol provider is registered.
 *
 * @param protocol The protocol type
 * @returns true if the protocol is registered
 */
export const hasProtocol = protocolRegistry.hasProtocol.bind(protocolRegistry);

/**
 * List all registered protocol provider types.
 *
 * @returns Array of protocol types
 */
export const listProtocols =
  protocolRegistry.listProtocols.bind(protocolRegistry);
