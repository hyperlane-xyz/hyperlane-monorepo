import { assert } from '@hyperlane-xyz/utils';

import { IProvider, ISigner } from './altvm.js';
import type { ChainMetadataForAltVM } from './chain.js';
import { IRawHookArtifactManager } from './hook.js';
import { IRawIsmArtifactManager } from './ism.js';
import { IRawMailboxArtifactManager } from './mailbox.js';
import { MinimumRequiredGasByAction } from './mingas.js';
import { AnnotatedTx, TxReceipt } from './module.js';
import { ProtocolType } from './protocolType.js';
import {
  ITransactionSubmitter,
  JsonRpcSubmitterConfig,
  TransactionSubmitterConfig,
} from './submitter.js';
import { type FeeReadContext, IRawFeeArtifactManager } from './fee.js';
import { IRawWarpArtifactManager } from './warp.js';
import { IRawValidatorAnnounceArtifactManager } from './validator-announce.js';

/**
 * Protocol-agnostic addresses produced by a completed core deployment.
 *
 * Unknown registry entries remain supported without coupling provider-sdk to
 * the registry package. Protocol implementations must validate additional
 * addresses before narrowing this interface with protocol-specific fields.
 */
export interface ProtocolChainAddresses {
  mailbox: string;
  validatorAnnounce: string;
  interchainSecurityModule: string;
  merkleTreeHook: string;
  [address: string]: string | undefined;
}

export function isProtocolChainAddresses(
  addresses: Record<string, string | undefined>,
): addresses is ProtocolChainAddresses {
  return (
    typeof addresses['mailbox'] === 'string' &&
    typeof addresses['validatorAnnounce'] === 'string' &&
    typeof addresses['interchainSecurityModule'] === 'string' &&
    typeof addresses['merkleTreeHook'] === 'string'
  );
}

/**
 * Optional complete chain context supplied to protocol operations.
 * When addresses are provided, every shared core address must be present.
 */
export interface ProtocolProviderContext {
  addresses?: ProtocolChainAddresses;
}

/**
 * Context for artifact managers created while a deployment is in progress.
 * Unlike ProtocolProviderContext, its address set may be incomplete.
 */
export interface ProtocolArtifactManagerContext {
  addresses?: Partial<ProtocolChainAddresses>;
}

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
    config: TConfig & ProtocolProviderContext,
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
   * @param context Optional known addresses for the target chain
   * @returns A protocol-specific Hook artifact manager
   */
  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: ProtocolArtifactManagerContext,
  ): IRawHookArtifactManager;

  /**
   * Creates a Warp artifact manager for the protocol.
   * The artifact manager provides protocol-specific readers and writers
   * that handle warp token operations using the Artifact API pattern.
   *
   * @param chainMetadata Chain metadata for the target chain
   * @param context Optional known addresses for the target chain
   * @returns A protocol-specific Warp artifact manager
   */
  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: ProtocolArtifactManagerContext,
  ): IRawWarpArtifactManager;

  /**
   * Creates a Mailbox artifact manager for the protocol.
   * The artifact manager provides protocol-specific readers and writers
   * that handle Mailbox operations using the Artifact API pattern.
   *
   * @param chainMetadata Chain metadata for the target chain
   * @returns A protocol-specific Mailbox artifact manager
   */
  createMailboxArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawMailboxArtifactManager;

  /**
   * Creates a Validator Announce artifact manager for the protocol.
   * The artifact manager provides protocol-specific readers and writers
   * that handle Validator Announce operations using the Artifact API pattern.
   *
   * Not all protocols support validator announce (e.g., Cosmos does not).
   *
   * @param chainMetadata Chain metadata for the target chain
   * @returns A protocol-specific Validator Announce artifact manager, or null if not supported
   */
  createValidatorAnnounceArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawValidatorAnnounceArtifactManager | null;

  /**
   * Creates a Fee artifact manager for the protocol.
   * The artifact manager provides protocol-specific readers and writers
   * that handle fee operations using the Artifact API pattern.
   *
   * Not all protocols support fee programs.
   *
   * @param chainMetadata Chain metadata for the target chain
   * @param context Fee read context and optional known addresses
   * @returns A protocol-specific Fee artifact manager, or null if not supported
   */
  createFeeArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context: FeeReadContext & ProtocolArtifactManagerContext,
  ): IRawFeeArtifactManager | null;

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
