import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddress,
  HookType,
  IRawHookArtifactManager,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';

import { RadixSigner } from '../clients/signer.js';
import { RadixBase } from '../utils/base.js';

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

  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new RadixMerkleTreeHookReader(
          this.gateway,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new RadixIgpHookReader(
          this.gateway,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported Hook type: ${type}`);
    }
  }

  createWriter<T extends HookType>(
    type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const baseSigner = signer.getBaseSigner();

    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new RadixMerkleTreeHookWriter(
          this.gateway,
          baseSigner,
          this.base,
          this.mailboxAddress,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new RadixIgpHookWriter(
          this.gateway,
          baseSigner,
          this.base,
          this.nativeTokenDenom,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported Hook type: ${type}`);
    }
  }
}
