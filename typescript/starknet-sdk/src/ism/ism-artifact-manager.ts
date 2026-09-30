import {
  ProtocolType,
  type ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactState,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type DeployedRawIsmArtifact,
  type IRawIsmArtifactManager,
  type IsmArtifactReaderFactories,
  type IsmArtifactWriterFactories,
  IsmType,
  type RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
  throwUnsupportedIsmType,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { getIsmType } from './ism-query.js';
import {
  StarknetAggregationIsmReader,
  StarknetPausableIsmReader,
} from './aggregation-ism-artifact-reader.js';
import {
  StarknetRoutingIsmReader,
  StarknetRoutingIsmWriter,
} from './domain-routing-ism-artifact-manager.js';
import {
  StarknetMerkleRootMultisigIsmReader,
  StarknetMerkleRootMultisigIsmWriter,
} from './merkle-root-multisig-ism-artifact-manager.js';
import {
  StarknetMessageIdMultisigIsmReader,
  StarknetMessageIdMultisigIsmWriter,
} from './message-id-multisig-ism-artifact-manager.js';
import {
  StarknetTestIsmReader,
  StarknetTestIsmWriter,
} from './test-ism-artifact-manager.js';

export class StarknetIsmArtifactManager implements IRawIsmArtifactManager {
  private readonly provider: StarknetProvider;

  constructor(chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(chainMetadata);
  }

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const type = await getIsmType(this.provider.getRawProvider(), address);
    const artifactType = altVMIsmTypeToProviderSdkType(type);
    if (artifactType === IsmType.UNKNOWN) {
      return {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.UNKNOWN },
        deployed: { address: normalizeStarknetAddressSafe(address) },
      };
    }

    const reader = this.createReader(artifactType);
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const readers: IsmArtifactReaderFactories = {
      [IsmType.AGGREGATION]: () =>
        new StarknetAggregationIsmReader(this.provider),
      [IsmType.PAUSABLE]: () => new StarknetPausableIsmReader(this.provider),
      [IsmType.TEST_ISM]: () => new StarknetTestIsmReader(this.provider),
      [IsmType.MERKLE_ROOT_MULTISIG]: () =>
        new StarknetMerkleRootMultisigIsmReader(this.provider),
      [IsmType.MESSAGE_ID_MULTISIG]: () =>
        new StarknetMessageIdMultisigIsmReader(this.provider),
      [IsmType.ROUTING]: () => new StarknetRoutingIsmReader(this.provider),
    };

    const readerFactory = readers[type];
    if (!readerFactory) {
      return throwUnsupportedIsmType(type, ProtocolType.Starknet);
    }

    return readerFactory();
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const starknetSigner = this.requireStarknetSigner(signer);
    const writers: IsmArtifactWriterFactories = {
      [IsmType.TEST_ISM]: () =>
        new StarknetTestIsmWriter(this.provider, starknetSigner),
      [IsmType.MERKLE_ROOT_MULTISIG]: () =>
        new StarknetMerkleRootMultisigIsmWriter(this.provider, starknetSigner),
      [IsmType.MESSAGE_ID_MULTISIG]: () =>
        new StarknetMessageIdMultisigIsmWriter(this.provider, starknetSigner),
      [IsmType.ROUTING]: () =>
        new StarknetRoutingIsmWriter(this.provider, starknetSigner),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedIsmType(type, ProtocolType.Starknet);
    }

    return writer();
  }
}
