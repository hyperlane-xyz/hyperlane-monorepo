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
  type TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { getNewContractExpectedNonce } from '../utils/base-query.js';
import {
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getNewIsmAddress } from './base.js';
import { getTestIsmConfig } from './ism-query.js';
import { getCreateTestIsmTx } from './ism-tx.js';

export class AleoTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await getTestIsmConfig(this.aleoClient, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.TEST_ISM,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}

export class AleoTestIsmWriter
  extends AleoTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, AleoReceipt[]]
  > {
    const ismManagerProgramId = await this.signer.getIsmManager();
    const transaction = getCreateTestIsmTx(ismManagerProgramId);

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
      TestIsmConfig,
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
    _artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedAleoTransaction[]> {
    return [];
  }
}
