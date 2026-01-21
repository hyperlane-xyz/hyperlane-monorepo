import { TronWeb } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type DeployedHookArtifact,
  type HookType,
  type IRawHookArtifactManager,
  type RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';

import { type TronSigner } from '../clients/signer.js';
import { TronHookTypes } from '../utils/types.js';

import { getHookType } from './hook-query.js';
import { TronIgpHookReader, TronIgpHookWriter } from './igp-hook.js';
import {
  TronMerkleTreeHookReader,
  TronMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

/**
 * Maps Tron-specific Hook blueprint names to provider-sdk Hook types.
 */
function tronHookTypeToProviderSdkType(tronType: TronHookTypes): HookType {
  switch (tronType) {
    case TronHookTypes.MERKLE_TREE:
      return AltVM.HookType.MERKLE_TREE;
    case TronHookTypes.INTERCHAIN_GAS_PAYMASTER:
      return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
    default:
      throw new Error(`Unknown Tron Hook type: ${tronType}`);
  }
}

/**
 * Tron Hook Artifact Manager implementing IRawHookArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Provides factory methods for creating readers and writers
 * - Supports IGP and MerkleTree hook types
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class TronHookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly tronweb: TronWeb,
    private readonly mailboxAddress: string,
  ) {}

  /**
   * Read a hook of unknown type from the blockchain.
   *
   * @param address - Address of the hook to read
   * @returns Deployed hook artifact with configuration
   */
  async readHook(address: string): Promise<DeployedHookArtifact> {
    const tronHookType = await getHookType(this.tronweb, address);
    const hookType = tronHookTypeToProviderSdkType(tronHookType);
    const reader = this.createReader(hookType);
    return reader.read(address);
  }

  /**
   * Factory method to create type-specific ISM readers (public interface).
   * Note: This method doesn't have access to query client yet, so it must be async.
   *
   * @param type - ISM type to create reader for
   * @returns Type-specific ISM reader
   */
  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new TronMerkleTreeHookReader(
          this.tronweb,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new TronIgpHookReader(this.tronweb) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported Hook type: ${type}`);
    }
  }

  createWriter<T extends HookType>(
    type: T,
    signer: TronSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new TronMerkleTreeHookWriter(
          this.tronweb,
          signer,
          this.mailboxAddress,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new TronIgpHookWriter(
          this.tronweb,
          signer,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }
}
