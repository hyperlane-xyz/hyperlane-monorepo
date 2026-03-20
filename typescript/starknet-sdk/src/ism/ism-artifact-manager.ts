import { AltVM, type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
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
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
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
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const type = await this.provider.getIsmType({ ismAddress: address });
    if (type === AltVM.IsmType.CUSTOM) {
      return this.createReader(AltVM.IsmType.TEST_ISM).read(address);
    }
    const reader = this.createReader(altVMIsmTypeToProviderSdkType(type));
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const readers: Partial<{
      [K in IsmType]: ArtifactReader<
        RawIsmArtifactConfigs[K],
        DeployedIsmAddress
      >;
    }> = {
      testIsm: new StarknetTestIsmReader(this.provider),
      merkleRootMultisigIsm: new StarknetMerkleRootMultisigIsmReader(
        this.provider,
      ),
      messageIdMultisigIsm: new StarknetMessageIdMultisigIsmReader(
        this.provider,
      ),
      domainRoutingIsm: new StarknetRoutingIsmReader(this.provider),
    };
    const reader = readers[type];
    assert(reader, `Unsupported Starknet ISM type: ${type}`);
    return reader;
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    const writers: Partial<{
      [K in IsmType]: (
        starknetSigner: StarknetSigner,
      ) => ArtifactWriter<RawIsmArtifactConfigs[K], DeployedIsmAddress>;
    }> = {
      testIsm: (starknetSigner) =>
        new StarknetTestIsmWriter(this.provider, starknetSigner),
      merkleRootMultisigIsm: (starknetSigner) =>
        new StarknetMerkleRootMultisigIsmWriter(this.provider, starknetSigner),
      messageIdMultisigIsm: (starknetSigner) =>
        new StarknetMessageIdMultisigIsmWriter(this.provider, starknetSigner),
      domainRoutingIsm: (starknetSigner) =>
        new StarknetRoutingIsmWriter(this.provider, starknetSigner),
    };
    const writer = writers[type];
    assert(writer, `Unsupported Starknet ISM type: ${type}`);
    const starknetSigner = this.requireStarknetSigner(signer);
    return writer(starknetSigner);
  }
}
