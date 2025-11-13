import { assert } from '@hyperlane-xyz/utils';

import { ProtocolProvider } from './factory.js';
import { ProtocolType } from './protocol.js';

/**
 * Internal registry for managing protocol provider factories.
 * This class is not exported - protocol packages interact through the registrar interface.
 */
class ProtocolProviderFactoryRegistry {
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

  getProtocol(protocol: ProtocolType): ProtocolProvider {
    const factory = this.protocols.get(protocol);
    assert(
      factory,
      `Protocol '${protocol}' is not registered. Available protocols: ${this.listProtocols().join(', ') || 'none'}`,
    );

    return factory();
  }
}

// Singleton registry instance
const protocolRegistry = new ProtocolProviderFactoryRegistry();

/**
 * Registration interface passed to protocol packages.
 * This allows protocol packages to register their implementations without
 * importing the registry directly.
 */
export interface ProtocolRegistrar {
  registerProtocol(
    protocol: ProtocolType,
    factory: () => ProtocolProvider,
  ): void;
}

/**
 * Trigger registration of a protocol implementation.
 * Call this function with a registration function from a protocol package.
 *
 * @param registerFn Registration function implemented by the protocol package.
 *                   Should accept a ProtocolRegistrar and use it to register the protocol.
 *
 * @example
 * ```typescript
 * import { registerProtocol } from '@hyperlane-exp/impl-kit';
 * import { registerEvmProtocol } from '@hyperlane-exp/impl-evm';
 *
 * // Explicit registration (side-effect free imports)
 * registerProtocol(registerEvmProtocol);
 * ```
 *
 * @example
 * ```typescript
 * // In impl-evm/src/register.ts
 * export const registerEvmProtocol = (registrar: ProtocolRegistrar) => {
 *   registrar.registerProvider('evm', () => new EvmProtocolProviderFactory());
 * };
 * ```
 */
export function registerProtocol(
  registerFn: (registrar: ProtocolRegistrar) => void,
): void {
  const registrar: ProtocolRegistrar = {
    registerProtocol(
      protocol: ProtocolType,
      factory: () => ProtocolProvider,
    ): void {
      protocolRegistry.registerProtocol(protocol, factory);
    },
  };

  registerFn(registrar);
}

/**
 * Create a protocol provider instance by protocol type.
 *
 * @param protocol The protocol type (e.g., ProtocolType.Ethereum, ProtocolType.Sealevel, ProtocolType.Radix)
 * @returns A new {@link ProtocolProvider} instance
 * @throws Error if the protocol is not registered
 *
 * @example
 * ```typescript
 * const provider = createProtocolProvider(ProtocolType.Ethereum);
 * const reader = await provider.getProvider({ chainId: 1, ... });
 * ```
 */
export function getProtocolProviderFactory(
  protocol: ProtocolType,
): ProtocolProvider {
  return protocolRegistry.getProtocol(protocol);
}

/**
 * Check if a protocol provider is registered.
 *
 * @param protocol The protocol type
 * @returns true if the protocol is registered
 */
export function hasProtocolProviderFactory(protocol: ProtocolType): boolean {
  return protocolRegistry.hasProtocol(protocol);
}

/**
 * List all registered protocol provider types.
 *
 * @returns Array of protocol types
 */
export function listProtocolProviders(): ProtocolType[] {
  return protocolRegistry.listProtocols();
}
