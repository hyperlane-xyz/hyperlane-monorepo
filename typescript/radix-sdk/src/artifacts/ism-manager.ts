import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  IsmType,
  RawIsmArtifactReader,
  RawIsmArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { RadixProvider } from '../clients/provider.js';
import { RadixSigner } from '../clients/signer.js';
import {
  MerkleRootMultisigIsmArtifactReader,
  MerkleRootMultisigIsmArtifactWriter,
  MessageIdMultisigIsmArtifactReader,
  MessageIdMultisigIsmArtifactWriter,
} from '../core/multisig-ism.js';
// Import all artifact implementations
import {
  DomainRoutingIsmArtifactReader,
  DomainRoutingIsmArtifactWriter,
} from '../core/routing-ism.js';
import {
  TestIsmArtifactReader,
  TestIsmArtifactWriter,
} from '../core/test-ism.js';
import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

/**
 * Factory for creating ISM artifact readers and writers.
 *
 * Provides a unified interface for creating artifact readers (read-only) and writers
 * (create/update) for all ISM types. Supports construction from either existing
 * RadixProvider instances or directly from chain metadata.
 *
 * @example
 * // Create from existing provider
 * const manager = RadixIsmArtifactManager.fromProvider(provider);
 * const reader = manager.createReader('domainRoutingIsm');
 *
 * @example
 * // Create from chain metadata
 * const manager = await RadixIsmArtifactManager.fromChainMetadata(metadata);
 * const writer = manager.createWriter('merkleRootMultisigIsm', signer, account);
 */
export class RadixIsmArtifactManager {
  private gateway: GatewayApiClient;
  private base: RadixBase;

  private constructor(gateway: GatewayApiClient, base: RadixBase) {
    this.gateway = gateway;
    this.base = base;
  }

  /**
   * Create an artifact manager from an existing RadixProvider instance.
   *
   * @param provider - Existing RadixProvider instance
   * @returns RadixIsmArtifactManager instance
   */
  static fromProvider(provider: RadixProvider): RadixIsmArtifactManager {
    return new RadixIsmArtifactManager(
      provider.getGateway(),
      provider.getBase(),
    );
  }

  /**
   * Create an artifact manager directly from chain metadata.
   *
   * This creates a new RadixProvider internally and extracts the necessary
   * dependencies for artifact operations.
   *
   * @param chainMetadata - Chain metadata containing RPC URLs, chain ID, etc.
   * @returns Promise resolving to RadixIsmArtifactManager instance
   */
  static async fromChainMetadata(
    chainMetadata: ChainMetadataForAltVM,
  ): Promise<RadixIsmArtifactManager> {
    assert(chainMetadata.rpcUrls, 'Chain metadata must include rpcUrls');

    const provider = await RadixProvider.connect(
      chainMetadata.rpcUrls.map((rpc) => rpc.http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
    return RadixIsmArtifactManager.fromProvider(provider);
  }

  /**
   * Create an artifact reader for a specific ISM type.
   *
   * Readers provide read-only access to on-chain ISM configurations.
   *
   * @param ismType - Type of ISM to read (e.g., 'domainRoutingIsm', 'merkleRootMultisigIsm')
   * @returns ArtifactReader instance for the specified ISM type
   * @throws Error if ISM type is unknown
   *
   * @example
   * const reader = manager.createReader('domainRoutingIsm');
   * const config = await reader.read(ismAddress);
   */
  createReader<T extends IsmType>(ismType: T): RawIsmArtifactReader<T> {
    switch (ismType) {
      case 'domainRoutingIsm':
        return new DomainRoutingIsmArtifactReader(
          this.gateway,
        ) as unknown as RawIsmArtifactReader<T>;
      case 'merkleRootMultisigIsm':
        return new MerkleRootMultisigIsmArtifactReader(
          this.gateway,
        ) as unknown as RawIsmArtifactReader<T>;
      case 'messageIdMultisigIsm':
        return new MessageIdMultisigIsmArtifactReader(
          this.gateway,
        ) as unknown as RawIsmArtifactReader<T>;
      case 'testIsm':
        return new TestIsmArtifactReader(
          this.gateway,
        ) as unknown as RawIsmArtifactReader<T>;
      default:
        throw new Error(`Unknown ISM type: ${ismType}`);
    }
  }

  /**
   * Create an artifact writer for a specific ISM type.
   *
   * Writers provide create and update operations for ISM artifacts.
   *
   * @param ismType - Type of ISM to write (e.g., 'domainRoutingIsm', 'merkleRootMultisigIsm')
   * @param signer - RadixBaseSigner or RadixSigner instance for signing transactions
   * @param account - Account address that will create/own the artifacts
   * @returns ArtifactWriter instance for the specified ISM type
   * @throws Error if ISM type is unknown
   *
   * @example
   * const writer = manager.createWriter('domainRoutingIsm', signer, account);
   * const [{ deployedIsm }, receipts] = await writer.create(config);
   */
  createWriter<T extends IsmType>(
    ismType: T,
    signer: RadixBaseSigner | RadixSigner,
    account: string,
  ): RawIsmArtifactWriter<T> {
    // Extract RadixBaseSigner if RadixSigner provided
    const baseSigner =
      signer instanceof RadixSigner ? signer.getBaseSigner() : signer;

    switch (ismType) {
      case 'domainRoutingIsm':
        return new DomainRoutingIsmArtifactWriter(
          account,
          this.gateway,
          this.base,
          baseSigner,
        ) as unknown as RawIsmArtifactWriter<T>;
      case 'merkleRootMultisigIsm':
        return new MerkleRootMultisigIsmArtifactWriter(
          account,
          this.base,
          baseSigner,
        ) as unknown as RawIsmArtifactWriter<T>;
      case 'messageIdMultisigIsm':
        return new MessageIdMultisigIsmArtifactWriter(
          account,
          this.base,
          baseSigner,
        ) as unknown as RawIsmArtifactWriter<T>;
      case 'testIsm':
        return new TestIsmArtifactWriter(
          account,
          this.base,
          baseSigner,
        ) as unknown as RawIsmArtifactWriter<T>;
      default:
        throw new Error(`Unknown ISM type: ${ismType}`);
    }
  }
}
