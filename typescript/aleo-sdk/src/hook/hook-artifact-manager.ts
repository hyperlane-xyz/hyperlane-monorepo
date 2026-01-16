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

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';

import { getHookType } from './hook-query.js';
import { AleoIgpHookReader, AleoIgpHookWriter } from './igp-hook.js';
import {
  AleoMerkleTreeHookReader,
  AleoMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

export class AleoHookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly aleoClient: AnyAleoNetworkClient,
    private readonly mailboxAddress: string,
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
    const writers: {
      [K in HookType]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      [AltVM.HookType.MERKLE_TREE]: () =>
        new AleoMerkleTreeHookWriter(
          this.aleoClient,
          signer,
          this.mailboxAddress,
        ),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        new AleoIgpHookWriter(this.aleoClient, signer, this.mailboxAddress),
    };

    return writers[type]();
  }
}
