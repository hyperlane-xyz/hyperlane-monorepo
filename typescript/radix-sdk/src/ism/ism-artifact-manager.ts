import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactReaderFactories,
  IsmArtifactWriterFactories,
  IsmType,
  RawIsmArtifactConfigs,
  throwUnsupportedIsmType,
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

/**
 * Maps Radix-specific ISM blueprint names to provider-sdk ISM types.
 */
function radixIsmTypeToProviderSdkType(radixType: RadixIsmTypes): IsmType {
  switch (radixType) {
    case RadixIsmTypes.MERKLE_ROOT_MULTISIG:
      return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    case RadixIsmTypes.MESSAGE_ID_MULTISIG:
      return AltVM.IsmType.MESSAGE_ID_MULTISIG;
    case RadixIsmTypes.ROUTING_ISM:
      return AltVM.IsmType.ROUTING;
    case RadixIsmTypes.NOOP_ISM:
      return AltVM.IsmType.TEST_ISM;
    default:
      throw new Error(`Unknown Radix ISM type: ${radixType}`);
  }
}

export class RadixIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(
    private readonly gateway: GatewayApiClient,
    private readonly base: RadixBase,
  ) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const radixIsmType = await getIsmType(this.gateway, address);
    const ismType = radixIsmTypeToProviderSdkType(radixIsmType);
    const reader = this.createReader(ismType);
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const readers: IsmArtifactReaderFactories = {
      [AltVM.IsmType.TEST_ISM]: () => new RadixTestIsmReader(this.gateway),
      [AltVM.IsmType.MERKLE_ROOT_MULTISIG]: () =>
        new RadixMerkleRootMultisigIsmReader(this.gateway),
      [AltVM.IsmType.MESSAGE_ID_MULTISIG]: () =>
        new RadixMessageIdMultisigIsmReader(this.gateway),
      [AltVM.IsmType.ROUTING]: () => new RadixRoutingIsmRawReader(this.gateway),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedIsmType(type, ProtocolType.Radix);
    }

    return reader();
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const baseSigner = signer.getBaseSigner();

    const writers: IsmArtifactWriterFactories = {
      [AltVM.IsmType.TEST_ISM]: () =>
        new RadixTestIsmWriter(this.gateway, baseSigner, this.base),
      [AltVM.IsmType.MERKLE_ROOT_MULTISIG]: () =>
        new RadixMerkleRootMultisigIsmWriter(
          this.gateway,
          baseSigner,
          this.base,
        ),
      [AltVM.IsmType.MESSAGE_ID_MULTISIG]: () =>
        new RadixMessageIdMultisigIsmWriter(
          this.gateway,
          baseSigner,
          this.base,
        ),
      [AltVM.IsmType.ROUTING]: () =>
        new RadixRoutingIsmRawWriter(this.gateway, baseSigner, this.base),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedIsmType(type, ProtocolType.Radix);
    }

    return writer();
  }
}
