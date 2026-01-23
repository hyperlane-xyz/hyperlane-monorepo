import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { AltVM } from '../../index.js';

export class MessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(protected readonly provider: AltVM.IProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await this.provider.getMessageIdMultisigIsm({
      ismAddress: address,
    });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ismConfig.validators,
        threshold: ismConfig.threshold,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}

export class MessageIdMultisigIsmWriter
  extends MessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    provider: AltVM.IProvider,
    private readonly signer: AltVM.ISigner<any, any>,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<[ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, any[]]> {
    const { config } = artifact;

    const { ismAddress, receipts } =
      await this.signer.createMessageIdMultisigIsm({
        validators: config.validators,
        threshold: config.threshold,
      });

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    };

    return [deployedArtifact, [...receipts]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<any[]> {
    return [];
  }
}

export class MerkleRootMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(protected readonly provider: AltVM.IProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await this.provider.getMerkleRootMultisigIsm({
      ismAddress: address,
    });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: ismConfig.validators,
        threshold: ismConfig.threshold,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}

export class MerkleRootMultisigIsmWriter
  extends MerkleRootMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    provider: AltVM.IProvider,
    private readonly signer: AltVM.ISigner<any, any>,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<[ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, any[]]> {
    const { config } = artifact;

    const { ismAddress, receipts } =
      await this.signer.createMerkleRootMultisigIsm({
        validators: config.validators,
        threshold: config.threshold,
      });

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    };

    return [deployedArtifact, [...receipts]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<any[]> {
    return [];
  }
}
