import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookType,
  IRawHookArtifactManager,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';

import { RadixSigner } from '../clients/signer.js';
import { RadixBase } from '../utils/base.js';

import { getHookType } from './hook-query.js';
import { RadixIgpHookReader, RadixIgpHookWriter } from './igp-hook.js';
import {
  RadixMerkleTreeHookReader,
  RadixMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

export class RadixHookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly gateway: GatewayApiClient,
    private readonly base: RadixBase,
    private readonly mailboxAddress: string,
    private readonly nativeTokenDenom: string,
  ) {}

  async readHook(address: string): Promise<DeployedHookArtifact> {
    // Detect hook type first
    const radixHookType = await getHookType(this.gateway, address);

    // Map Radix hook type to AltVM hook type
    const hookType = this.radixHookTypeToAltVMHookType(radixHookType);

    // Get the appropriate reader and read the hook
    const reader = this.createReader(hookType);
    return reader.read(address);
  }

  private radixHookTypeToAltVMHookType(radixType: string): HookType {
    switch (radixType) {
      case 'InterchainGasPaymaster':
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      case 'MerkleTreeHook':
        return AltVM.HookType.MERKLE_TREE;
      default:
        throw new Error(`Unknown Radix hook type: ${radixType}`);
    }
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
      merkleTreeHook: () => new RadixMerkleTreeHookReader(this.gateway),
      interchainGasPaymaster: () => new RadixIgpHookReader(this.gateway),
    };

    return readers[type]();
  }

  createWriter<T extends HookType>(
    type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const baseSigner = signer.getBaseSigner();

    const writers: {
      [K in HookType]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      merkleTreeHook: () =>
        new RadixMerkleTreeHookWriter(
          this.gateway,
          baseSigner,
          this.base,
          this.mailboxAddress,
        ),
      interchainGasPaymaster: () =>
        new RadixIgpHookWriter(
          this.gateway,
          baseSigner,
          this.base,
          this.nativeTokenDenom,
        ),
    };

    return writers[type]();
  }
}
