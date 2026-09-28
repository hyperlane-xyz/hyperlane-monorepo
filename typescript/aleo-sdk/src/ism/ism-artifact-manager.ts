import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type DeployedRawIsmArtifact,
  type IRawIsmArtifactManager,
  type IsmArtifactReaderFactories,
  type IsmArtifactWriterFactories,
  type IsmType,
  type RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
  throwUnsupportedIsmType,
} from '@hyperlane-xyz/provider-sdk/ism';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { AleoIsmType } from '../utils/types.js';

import { getIsmType } from './ism-query.js';
import {
  AleoMessageIdMultisigIsmReader,
  AleoMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import {
  AleoRoutingIsmRawReader,
  AleoRoutingIsmRawWriter,
} from './routing-ism.js';
import { AleoTestIsmReader, AleoTestIsmWriter } from './test-ism.js';

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
      return throwUnsupportedIsmType(
        AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        ProtocolType.Aleo,
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
    const readers: IsmArtifactReaderFactories = {
      [AltVM.IsmType.TEST_ISM]: () => new AleoTestIsmReader(this.aleoClient),
      [AltVM.IsmType.MESSAGE_ID_MULTISIG]: () =>
        new AleoMessageIdMultisigIsmReader(this.aleoClient),
      [AltVM.IsmType.ROUTING]: () =>
        new AleoRoutingIsmRawReader(this.aleoClient),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedIsmType(type, ProtocolType.Aleo);
    }

    return reader();
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: AleoSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const writers: IsmArtifactWriterFactories = {
      [AltVM.IsmType.TEST_ISM]: () =>
        new AleoTestIsmWriter(this.aleoClient, signer),
      [AltVM.IsmType.MESSAGE_ID_MULTISIG]: () =>
        new AleoMessageIdMultisigIsmWriter(this.aleoClient, signer),
      [AltVM.IsmType.ROUTING]: () =>
        new AleoRoutingIsmRawWriter(this.aleoClient, signer),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedIsmType(type, ProtocolType.Aleo);
    }

    return writer();
  }
}
