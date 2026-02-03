import { assert } from '@hyperlane-xyz/utils';

import { IProvider, ISigner } from './altvm.js';
import { ChainMetadataForAltVM } from './chain.js';
import { IRawHookArtifactManager } from './hook.js';
import { IRawIsmArtifactManager } from './ism.js';
import { MinimumRequiredGasByAction } from './mingas.js';
import { AnnotatedTx, TxReceipt } from './module.js';
import {
  ITransactionSubmitter,
  JsonRpcSubmitterConfig,
  TransactionSubmitterConfig,
} from './submitter.js';

export enum ProtocolType {
  Ethereum = 'ethereum',
  Sealevel = 'sealevel',
  Cosmos = 'cosmos',
  CosmosNative = 'cosmosnative',
  Starknet = 'starknet',
  Radix = 'radix',
  Aleo = 'aleo',
  Tron = 'tron',
}

// A type that also allows for literal values of the enum
export type ProtocolTypeValue = `${ProtocolType}`;

export const ProtocolSmallestUnit = {
  [ProtocolType.Ethereum]: 'wei',
  [ProtocolType.Sealevel]: 'lamports',
  [ProtocolType.Cosmos]: 'uATOM',
  [ProtocolType.CosmosNative]: 'uATOM',
  [ProtocolType.Starknet]: 'fri',
  [ProtocolType.Radix]: 'attos',
  [ProtocolType.Aleo]: 'microcredits',
  [ProtocolType.Tron]: 'sun',
};

export type SignerConfig = Pick<
  JsonRpcSubmitterConfig,
  'privateKey' | 'accountAddress'
>;

/**
 * Interface describing the artifacts that should be implemented in a specific protocol
 * implementation
 */
export interface ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider>;
  createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<ISigner<AnnotatedTx, TxReceipt>>;

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    chainMetadata: ChainMetadataForAltVM,
    config: TConfig,
  ): Promise<ITransactionSubmitter>;

  /**
   * Creates an ISM artifact manager for reading and deploying ISM configurations.
   * This factory method enables the protocol-specific instantiation of artifact managers
   * that handle ISM operations using the Artifact API pattern.
   *
   * @param chainMetadata Chain metadata for the target chain
   * @returns A protocol-specific ISM artifact manager
   */
  createIsmArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager;

  /**
   * Creates a Hook artifact manager for the protocol.
   * The artifact manager provides protocol-specific readers and writers
   * that handle Hook operations using the Artifact API pattern.
   *
   * @param chainMetadata Chain metadata for the target chain
   * @param context Optional deployment context (mailbox address, etc.) needed by some hook types
   * @returns A protocol-specific Hook artifact manager
   */
  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ): IRawHookArtifactManager;

  getMinGas(): MinimumRequiredGasByAction;
}

/**
 * Registry for managing protocol providers.
 */
export class ProtocolProviderRegistry {
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
