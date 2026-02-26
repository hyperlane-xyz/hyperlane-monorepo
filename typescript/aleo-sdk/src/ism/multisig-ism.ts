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

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { getNewContractExpectedNonce } from '../utils/base-query.js';
import {
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getNewIsmAddress } from './base.js';
import { getMessageIdMultisigIsmConfig } from './ism-query.js';
import { getCreateMessageIdMultisigIsmTx } from './ism-tx.js';

export class AleoMessageIdMultisigIsmReader implements ArtifactReader<
  MultisigIsmConfig,
  DeployedIsmAddress
> {
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await getMessageIdMultisigIsmConfig(
      this.aleoClient,
      address,
    );

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

export class AleoMessageIdMultisigIsmWriter
  extends AleoMessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, AleoReceipt[]]
  > {
    const { config } = artifact;

    const ismManagerProgramId = await this.signer.getIsmManager();
    const transaction = getCreateMessageIdMultisigIsmTx(ismManagerProgramId, {
      validators: config.validators,
      threshold: config.threshold,
    });

    const expectedNonce = await getNewContractExpectedNonce(
      this.aleoClient,
      ismManagerProgramId,
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = await getNewIsmAddress(
      this.aleoClient,
      ismManagerProgramId,
      expectedNonce,
    );

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

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedAleoTransaction[]> {
    return [];
  }
}
