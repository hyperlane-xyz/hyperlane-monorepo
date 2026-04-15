import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { getNoopIsmConfig } from './ism-query.js';
import { getCreateNoopIsmTx } from './ism-tx.js';

export class StarknetTestIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs['testIsm'],
  DeployedIsmAddress
> {
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>
  > {
    const noop = getNoopIsmConfig(address);
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: AltVM.IsmType.TEST_ISM },
      deployed: { address: noop.address },
    };
  }
}

export class StarknetTestIsmWriter
  extends StarknetTestIsmReader
  implements
    ArtifactWriter<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawIsmArtifactConfigs['testIsm']>,
  ): Promise<
    [
      ArtifactDeployed<RawIsmArtifactConfigs['testIsm'], DeployedIsmAddress>,
      TxReceipt[],
    ]
  > {
    const tx = getCreateNoopIsmTx();
    const receipt = await this.signer.sendAndConfirmTransaction(tx);
    const ismAddress = receipt.contractAddress;
    assert(ismAddress, 'failed to deploy Starknet noop ISM');
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: ismAddress },
      },
      [receipt],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawIsmArtifactConfigs['testIsm'],
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}
