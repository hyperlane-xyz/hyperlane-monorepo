import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedHookAddress,
  DeployedHookArtifact,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';

import type { SvmSigner } from '../signer.js';
import type { SvmProgramAddresses } from '../types.js';

import { detectHookType } from './hook-query.js';
import {
  DEFAULT_IGP_CONTEXT,
  SvmIgpHookReader,
  SvmIgpHookWriter,
  deriveIgpSalt,
} from './igp-hook.js';
import {
  SvmMerkleTreeHookReader,
  SvmMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

/**
 * SVM Hook Artifact Manager.
 *
 * This manager:
 * - Detects hook types and delegates to specialized readers
 * - Provides factory methods for creating readers and writers
 *
 * Supported hook types:
 * - merkleTreeHook (built into mailbox)
 * - interchainGasPaymaster (IGP program)
 *
 * Note: This doesn't implement IRawHookArtifactManager because that interface
 * expects ISigner but we use SvmSigner. The API is compatible otherwise.
 */
export class SvmHookArtifactManager {
  private readonly salt: Uint8Array;

  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly programAddresses: SvmProgramAddresses,
    context: string = DEFAULT_IGP_CONTEXT,
  ) {
    this.salt = deriveIgpSalt(context);
  }

  /**
   * Read a hook of unknown type from the blockchain.
   *
   * @param address - Hook address (program ID for IGP, mailbox for merkle tree)
   * @returns Deployed hook artifact with configuration
   */
  async readHook(address: string): Promise<DeployedHookArtifact> {
    const addr = address as Address;
    const hookType = await detectHookType(this.rpc, addr);

    const typeKey = this.altVmToTypeKey(hookType);
    const reader = this.createReader(typeKey);
    return reader.read(address);
  }

  /**
   * Factory method to create type-specific hook readers.
   *
   * @param type - Hook type to create reader for
   * @returns Type-specific hook reader
   */
  createReader<T extends keyof RawHookArtifactConfigs>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case 'merkleTreeHook':
        return new SvmMerkleTreeHookReader(
          this.rpc,
          this.programAddresses.mailbox,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case 'interchainGasPaymaster':
        return new SvmIgpHookReader(
          this.rpc,
          this.programAddresses.igp,
          this.salt,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported hook type: ${type}`);
    }
  }

  /**
   * Factory method to create type-specific hook writers.
   *
   * @param type - Hook type to create writer for
   * @param signer - SVM signer to use for transactions
   * @returns Type-specific hook writer
   */
  createWriter<T extends keyof RawHookArtifactConfigs>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case 'merkleTreeHook':
        return new SvmMerkleTreeHookWriter(
          this.rpc,
          this.programAddresses.mailbox,
          signer,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case 'interchainGasPaymaster':
        return new SvmIgpHookWriter(
          this.rpc,
          this.programAddresses.igp,
          this.salt,
          signer,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported hook type: ${type}`);
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private altVmToTypeKey(hookType: HookType): keyof RawHookArtifactConfigs {
    switch (hookType) {
      case HookType.MERKLE_TREE:
        return 'merkleTreeHook';
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        return 'interchainGasPaymaster';
      default:
        throw new Error(`Unsupported hook type on Solana: ${hookType}`);
    }
  }
}
