import { DeliverTxResponse } from '@cosmjs/stargate';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { AnnotatedEncodeObject } from '../utils/types.js';

import { CosmosIsmQueryClient, getNoopIsmConfig } from './ism-query.js';
import { getCreateTestIsmTx } from './ism-tx.js';

/**
 * Reader for Cosmos NoopIsm (test ISM).
 * This is the simplest ISM type with no configuration beyond its address.
 */
export class CosmosTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await getNoopIsmConfig(this.query, address);

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

/**
 * Writer for Cosmos NoopIsm (test ISM).
 * Handles deployment of test ISMs which accept all messages without verification.
 */
export class CosmosTestIsmWriter
  extends CosmosTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: CosmosIsmQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, DeliverTxResponse[]]
  > {
    const transaction = await getCreateTestIsmTx(
      this.signer.getSignerAddress(),
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = getNewContractAddress(receipt);

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
  ): Promise<AnnotatedEncodeObject[]> {
    // NoopIsm has no mutable state
    return [];
  }
}
