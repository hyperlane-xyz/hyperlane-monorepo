import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmType,
  RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';

import { RadixSigner } from '../clients/signer.js';
import { RadixBase } from '../utils/base.js';
import { RadixIsmTypes } from '../utils/types.js';

import { getIsmType } from './ism-query.js';
import {
  RadixMerkleRootMultisigIsmReader,
  RadixMerkleRootMultisigIsmWriter,
  RadixMessageIdMultisigIsmReader,
  RadixMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import {
  RadixRoutingIsmRawReader,
  RadixRoutingIsmRawWriter,
} from './routing-ism.js';
import { RadixTestIsmReader, RadixTestIsmWriter } from './test-ism.js';

export class RadixIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(
    private readonly gateway: GatewayApiClient,
    private readonly base: RadixBase,
  ) {}

  async readIsm(address: string): Promise<DeployedIsmArtifact> {
    const radixIsmType = await getIsmType(this.gateway, address);

    // Map RadixIsmTypes to AltVM.IsmType
    let altVMType: AltVM.IsmType;
    switch (radixIsmType) {
      case RadixIsmTypes.MERKLE_ROOT_MULTISIG:
        altVMType = AltVM.IsmType.MERKLE_ROOT_MULTISIG;
        break;
      case RadixIsmTypes.MESSAGE_ID_MULTISIG:
        altVMType = AltVM.IsmType.MESSAGE_ID_MULTISIG;
        break;
      case RadixIsmTypes.ROUTING_ISM:
        altVMType = AltVM.IsmType.ROUTING;
        break;
      case RadixIsmTypes.NOOP_ISM:
        altVMType = AltVM.IsmType.TEST_ISM;
        break;
      default:
        throw new Error(`Unknown ISM ModuleType: ${radixIsmType}`);
    }

    const artifactIsmType = altVMIsmTypeToProviderSdkType(altVMType);
    const reader = this.createReader(artifactIsmType);
    return reader.read(address) as Promise<DeployedIsmArtifact>;
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddresses> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new RadixTestIsmReader(
          this.gateway,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new RadixMerkleRootMultisigIsmReader(
          this.gateway,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new RadixMessageIdMultisigIsmReader(
          this.gateway,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.ROUTING:
        return new RadixRoutingIsmRawReader(
          this.gateway,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddresses> {
    const baseSigner = signer.getBaseSigner();

    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new RadixTestIsmWriter(
          this.gateway,
          baseSigner,
          this.base,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new RadixMerkleRootMultisigIsmWriter(
          this.gateway,
          baseSigner,
          this.base,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new RadixMessageIdMultisigIsmWriter(
          this.gateway,
          baseSigner,
          this.base,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.ROUTING:
        return new RadixRoutingIsmRawWriter(
          this.gateway,
          baseSigner,
          this.base,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }
}
