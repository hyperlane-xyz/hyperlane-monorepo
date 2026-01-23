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

import { IgpHookReader, IgpHookWriter } from './igp-hook.js';
import {
  MerkleTreeHookReader,
  MerkleTreeHookWriter,
} from './merkle-tree-hook.js';

/**
 * Hook Artifact Manager implementing IRawHookArtifactManager.
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
export class HookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly provider: AltVM.IProvider,
    private readonly mailboxAddress: string,
    private readonly nativeTokenDenom: string,
  ) {}

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const altVMType = await this.provider.getHookType({
      hookAddress: address,
    });
    const artifactIsmType = altVmHookTypeToProviderHookType(altVMType);
    const reader = this.createReader(artifactIsmType);
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
        new MerkleTreeHookReader(this.provider),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        new IgpHookReader(this.provider),
    };

    const maybeReader = readers[type]();

    assert(maybeReader, `Hook writer for ${type} not found`);
    return maybeReader;
  }

  createWriter<T extends HookType>(
    type: T,
    signer: AltVM.ISigner<any, any>,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const writers: {
      [K in HookType]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      [AltVM.HookType.MERKLE_TREE]: () =>
        new MerkleTreeHookWriter(this.provider, signer, this.mailboxAddress),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        new IgpHookWriter(
          this.provider,
          signer,
          this.mailboxAddress,
          this.nativeTokenDenom,
        ),
    };

    const maybeWriter = writers[type]();

    assert(maybeWriter, `Hook writer for ${type} not found`);
    return maybeWriter;
  }
}
