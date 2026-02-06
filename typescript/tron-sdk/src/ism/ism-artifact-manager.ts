import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type DeployedRawIsmArtifact,
  type IRawIsmArtifactManager,
  type IsmType,
  type RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';

import { TronSigner } from '../clients/signer.js';
import { TronIsmTypes } from '../utils/types.js';

import { getIsmType } from './ism-query.js';
import {
  TronMerkleRootMultisigIsmReader,
  TronMerkleRootMultisigIsmWriter,
  TronMessageIdMultisigIsmReader,
  TronMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import {
  TronRoutingIsmRawReader,
  TronRoutingIsmRawWriter,
} from './routing-ism.js';
import { TronTestIsmReader, TronTestIsmWriter } from './test-ism.js';

/**
 * Maps Tron-specific ISM blueprint names to provider-sdk ISM types.
 */
function tronIsmTypeToProviderSdkType(tronType: TronIsmTypes): IsmType {
  switch (tronType) {
    case TronIsmTypes.MERKLE_ROOT_MULTISIG:
      return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    case TronIsmTypes.MESSAGE_ID_MULTISIG:
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    case TronIsmTypes.ROUTING_ISM:
      return AltVM.IsmType.ROUTING;
    case TronIsmTypes.NOOP_ISM:
      return AltVM.IsmType.TEST_ISM;
    default:
      throw new Error(`Unknown Tron ISM type: ${tronType}`);
  }
}

/**
 * Tron ISM Artifact Manager implementing IRawIsmArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Detects ISM types and delegates to specialized readers
 * - Provides factory methods for creating readers and writers
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class TronIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly tronweb: TronWeb) {}

  /**
   * Read an ISM of unknown type from the blockchain.
   *
   * @param address - Address of the ISM to read
   * @returns Deployed ISM artifact with configuration
   */
  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const tronIsmType = await getIsmType(this.tronweb, address);
    const ismType = tronIsmTypeToProviderSdkType(tronIsmType);
    const reader = this.createReader(ismType);
    return reader.read(address);
  }

  /**
   * Factory method to create type-specific ISM readers (public interface).
   * Note: This method doesn't have access to query client yet, so it must be async.
   *
   * @param type - ISM type to create reader for
   * @returns Type-specific ISM reader
   */
  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TronTestIsmReader(this.tronweb) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new TronMerkleRootMultisigIsmReader(
          this.tronweb,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new TronMessageIdMultisigIsmReader(
          this.tronweb,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new TronRoutingIsmRawReader(
          this.tronweb,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: TronSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TronTestIsmWriter(
          this.tronweb,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new TronMerkleRootMultisigIsmWriter(
          this.tronweb,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new TronMessageIdMultisigIsmWriter(
          this.tronweb,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new TronRoutingIsmRawWriter(
          this.tronweb,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }
}
