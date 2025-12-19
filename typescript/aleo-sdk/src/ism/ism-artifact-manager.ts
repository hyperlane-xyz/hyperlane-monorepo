import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  IsmConfigs,
  IsmType,
  RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { AnyAleoNetworkClient } from '../clients/base.js';
import { AleoIsmType } from '../utils/types.js';

import { getIsmType } from './ism-query.js';
import { AleoMessageIdMultisigIsmReader } from './multisig-ism.js';
import { AleoRoutingIsmRawReader } from './routing-ism.js';
import { AleoTestIsmReader } from './test-ism.js';

export class AleoIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly aleoClient: AnyAleoNetworkClient) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const aleoIsmType = await getIsmType(this.aleoClient, address);

    // Map AleoIsmType to AltVM.IsmType
    let altVMType: AltVM.IsmType;
    switch (aleoIsmType) {
      case AleoIsmType.MESSAGE_ID_MULTISIG:
        altVMType = AltVM.IsmType.MESSAGE_ID_MULTISIG;
        break;
      case AleoIsmType.ROUTING:
        altVMType = AltVM.IsmType.ROUTING;
        break;
      case AleoIsmType.TEST_ISM:
        altVMType = AltVM.IsmType.TEST_ISM;
        break;
      case AleoIsmType.MERKLE_ROOT_MULTISIG:
        throw new Error(
          `${AltVM.IsmType.MERKLE_ROOT_MULTISIG} is not supported on Aleo`,
        );
      default:
        throw new Error(`Unknown ISM type: ${aleoIsmType}`);
    }

    const artifactIsmType = altVMIsmTypeToProviderSdkType(altVMType);
    const reader = this.createReader(artifactIsmType);
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddresses> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new AleoTestIsmReader(
          this.aleoClient,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new AleoMessageIdMultisigIsmReader(
          this.aleoClient,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      case AltVM.IsmType.ROUTING:
        return new AleoRoutingIsmRawReader(
          this.aleoClient,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddresses
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  createWriter<T extends keyof IsmConfigs>(
    type: T,
    _signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddresses> {
    throw new Error(
      `ISM writers not yet implemented for Cosmos (requested type: ${type})`,
    );
  }
}
