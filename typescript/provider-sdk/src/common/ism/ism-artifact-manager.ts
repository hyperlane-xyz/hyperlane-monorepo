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
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';

import { AnnotatedTx, TxReceipt } from '../../module.js';

import {
  MerkleRootMultisigIsmReader,
  MerkleRootMultisigIsmWriter,
  MessageIdMultisigIsmReader,
  MessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import { RoutingIsmRawReader, RoutingIsmRawWriter } from './routing-ism.js';
import { TestIsmReader, TestIsmWriter } from './test-ism.js';

export class IsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly provider: AltVM.IProvider) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const altVMType = await this.provider.getIsmType({
      ismAddress: address,
    });
    const artifactIsmType = altVMIsmTypeToProviderSdkType(altVMType);
    const reader = this.createReader(artifactIsmType);
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TestIsmReader(this.provider) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new MessageIdMultisigIsmReader(
          this.provider,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new MerkleRootMultisigIsmReader(
          this.provider,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new RoutingIsmRawReader(
          this.provider,
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
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TestIsmWriter(
          this.provider,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new MessageIdMultisigIsmWriter(
          this.provider,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new MerkleRootMultisigIsmWriter(
          this.provider,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new RoutingIsmRawWriter(
          this.provider,
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
