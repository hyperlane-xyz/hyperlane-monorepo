import {
  AltVM,
  ProtocolType,
  type ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
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
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
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
    assert(
      type !== AltVM.IsmType.CUSTOM,
      `Unsupported Starknet ISM at ${address}; refusing to report it as testIsm`,
    );
    const reader = this.createReader(altVMIsmTypeToProviderSdkType(type));
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const readers: IsmArtifactReaderFactories = {
      staticAggregationIsm: () =>
        new StarknetAggregationIsmReader(this.provider),
      pausableIsm: () => new StarknetPausableIsmReader(this.provider),
      testIsm: () => new StarknetTestIsmReader(this.provider),
      merkleRootMultisigIsm: () =>
        new StarknetMerkleRootMultisigIsmReader(this.provider),
      messageIdMultisigIsm: () =>
        new StarknetMessageIdMultisigIsmReader(this.provider),
      domainRoutingIsm: () => new StarknetRoutingIsmReader(this.provider),
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
      testIsm: () => new StarknetTestIsmWriter(this.provider, starknetSigner),
      merkleRootMultisigIsm: () =>
        new StarknetMerkleRootMultisigIsmWriter(this.provider, starknetSigner),
      messageIdMultisigIsm: () =>
        new StarknetMessageIdMultisigIsmWriter(this.provider, starknetSigner),
      domainRoutingIsm: () =>
        new StarknetRoutingIsmWriter(this.provider, starknetSigner),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedIsmType(type, ProtocolType.Starknet);
    }

    return writer();
  }
}
