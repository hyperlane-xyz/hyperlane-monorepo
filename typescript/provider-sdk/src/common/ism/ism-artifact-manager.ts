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

import { IIsmProvider } from '../interfaces/ism/ism-provider.js';
import { IIsmSigner } from '../interfaces/ism/ism-signer.js';

import {
  MessageIdMultisigIsmReader,
  MessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import { RoutingIsmRawReader, RoutingIsmRawWriter } from './routing-ism.js';
import { TestIsmReader, TestIsmWriter } from './test-ism.js';

export class IsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly query: IIsmProvider) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const altVMType = await this.query.getIsmType({
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
        return new TestIsmReader(this.query) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new MessageIdMultisigIsmReader(
          this.query,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new RoutingIsmRawReader(this.query) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: IIsmSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TestIsmWriter(
          this.query,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new MessageIdMultisigIsmWriter(
          this.query,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new RoutingIsmRawWriter(
          this.query,
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
