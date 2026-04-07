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

export class StarknetMessageIdMultisigIsmReader implements ArtifactReader<
  RawIsmArtifactConfigs['messageIdMultisigIsm'],
  DeployedIsmAddress
> {
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >
  > {
    const ism = await this.provider.getMessageIdMultisigIsm({
      ismAddress: address,
    });
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
        validators: ism.validators,
        threshold: ism.threshold,
      },
      deployed: { address: ism.address },
    };
  }
}

export class StarknetMessageIdMultisigIsmWriter
  extends StarknetMessageIdMultisigIsmReader
  implements
    ArtifactWriter<
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawIsmArtifactConfigs['messageIdMultisigIsm']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawIsmArtifactConfigs['messageIdMultisigIsm'],
        DeployedIsmAddress
      >,
      TxReceipt[],
    ]
  > {
    const tx = await this.signer.getCreateMessageIdMultisigIsmTransaction({
      signer: this.signer.getSignerAddress(),
      validators: artifact.config.validators,
      threshold: artifact.config.threshold,
    });
    const receipt = await this.signer.sendAndConfirmTransaction(tx);
    const ismAddress = receipt.contractAddress;
    assert(ismAddress, 'failed to deploy Starknet message ID multisig ISM');
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
      RawIsmArtifactConfigs['messageIdMultisigIsm'],
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}
