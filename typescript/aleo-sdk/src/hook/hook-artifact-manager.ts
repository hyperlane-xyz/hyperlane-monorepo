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
  altVmHookTypeToProviderHookType,
} from '@hyperlane-xyz/provider-sdk/hook';
import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';

import { getHookType } from './hook-query.js';
import { AleoIgpHookReader, AleoIgpHookWriter } from './igp-hook.js';
import {
  AleoMerkleTreeHookReader,
  AleoMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

/**
 * Aleo Hook Artifact Manager implementing IRawHookArtifactManager.
 *
 * This manager:
 * - Provides factory methods for creating type-specific hook readers and writers
 * - Supports IGP and MerkleTree hook types
 * - Automatically detects hook type when reading deployed hooks
 *
 * Design: The mailbox address is optional at construction and only validated
 * when creating writers for deployment. This allows the manager to be used
 * for read-only operations without requiring deployment context.
 */
export class AleoHookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly aleoClient: AnyAleoNetworkClient,
    private readonly mailboxAddress?: string, // Required only for deployments
  ) {}

  async readHook(address: string): Promise<DeployedHookArtifact> {
    // Detect hook type first
    const aleoHookType = await getHookType(this.aleoClient, address);

    // Get the appropriate reader and read the hook
    const reader = this.createReader(
      altVmHookTypeToProviderHookType(aleoHookType),
    );
    return reader.read(address);
  }

  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const readers: {
      [K in HookType]: () => ArtifactReader<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      [AltVM.HookType.MERKLE_TREE]: () =>
        new AleoMerkleTreeHookReader(this.aleoClient),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        new AleoIgpHookReader(this.aleoClient),
    };

    return readers[type]();
  }

  createWriter<T extends HookType>(
    type: T,
    signer: AleoSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const mailboxAddress = this.mailboxAddress;
    assert(mailboxAddress, 'mailbox address required for hook deployment');

    const writers: {
      [K in HookType]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      [AltVM.HookType.MERKLE_TREE]: () =>
        new AleoMerkleTreeHookWriter(this.aleoClient, signer, mailboxAddress),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        new AleoIgpHookWriter(this.aleoClient, signer, mailboxAddress),
    };

    return writers[type]();
  }
}
