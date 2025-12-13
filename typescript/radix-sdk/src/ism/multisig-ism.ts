import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getMultisigIsmConfig } from './ism-query.js';
import {
  getCreateMerkleRootMultisigIsmTx,
  getCreateMessageIdMultisigIsmTx,
} from './ism-tx.js';

export class RadixMessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(private readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>> {
    const ismConfig = await getMultisigIsmConfig(this.gateway, address);

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

export class RadixMessageIdMultisigIsmWriter
  extends RadixMessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(gateway);
  }

  async create(
    artifact: Artifact<MultisigIsmConfig, DeployedIsmAddresses>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>, TxReceipt[]]
  > {
    const { config } = artifact;

    const transactionManifest = await getCreateMessageIdMultisigIsmTx(
      this.base,
      this.signer.getAddress(),
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(receipt);

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddresses
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>,
  ): Promise<AnnotatedRadixTransaction[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}

export class RadixMerkleRootMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(private readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>> {
    const ismConfig = await getMultisigIsmConfig(this.gateway, address);

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

export class RadixMerkleRootMultisigIsmWriter
  extends RadixMerkleRootMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(gateway);
  }

  async create(
    artifact: Artifact<MultisigIsmConfig, DeployedIsmAddresses>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>, TxReceipt[]]
  > {
    const { config } = artifact;

    const transactionManifest = await getCreateMerkleRootMultisigIsmTx(
      this.base,
      this.signer.getAddress(),
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(receipt);

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddresses
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>,
  ): Promise<AnnotatedRadixTransaction[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}
