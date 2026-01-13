import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
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

/**
 * Maps Aleo-specific ISM type values to provider-sdk ISM types.
 */
function aleoIsmTypeToAltVmType(aleoType: AleoIsmType): AltVM.IsmType {
  switch (aleoType) {
    case AleoIsmType.MESSAGE_ID_MULTISIG:
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    case AleoIsmType.ROUTING:
      return AltVM.IsmType.ROUTING;
    case AleoIsmType.TEST_ISM:
      return AltVM.IsmType.TEST_ISM;
    case AleoIsmType.MERKLE_ROOT_MULTISIG:
      throw new Error(
        `${AltVM.IsmType.MERKLE_ROOT_MULTISIG} is not supported on Aleo`,
      );
    default:
      throw new Error(`Unknown Aleo ISM type: ${aleoType}`);
  }
}

export class AleoIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly aleoClient: AnyAleoNetworkClient) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const aleoIsmType = await getIsmType(this.aleoClient, address);
    const altVMType = aleoIsmTypeToAltVmType(aleoIsmType);
    const artifactIsmType = altVMIsmTypeToProviderSdkType(altVMType);
    const reader = this.createReader(artifactIsmType);
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new AleoTestIsmReader(
          this.aleoClient,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new AleoMessageIdMultisigIsmReader(
          this.aleoClient,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new AleoRoutingIsmRawReader(
          this.aleoClient,
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
    _signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    throw new Error(
      `ISM writers not yet implemented for Aleo (requested type: ${type})`,
    );
  }
}
