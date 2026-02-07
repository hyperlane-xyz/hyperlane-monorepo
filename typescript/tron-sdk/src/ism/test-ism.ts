import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { TronSigner } from '../clients/signer.js';
import { TronReceipt, TronTransaction } from '../utils/types.js';

import { type TronIsmQueryClient, getNoopIsmConfig } from './ism-query.js';
import { getCreateTestIsmTx } from './ism-tx.js';

/**
 * Reader for Tron NoopIsm (test ISM).
 * This is the simplest ISM type with no configuration beyond its address.
 */
export class TronTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: TronIsmQueryClient) {}

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
 * Writer for Tron NoopIsm (test ISM).
 * Handles deployment of test ISMs which accept all messages without verification.
 */
export class TronTestIsmWriter
  extends TronTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: TronIsmQueryClient,
    private readonly signer: TronSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, TronReceipt[]]
  > {
    const transaction = await getCreateTestIsmTx(
      this.signer.getTronweb(),
      this.signer.getSignerAddress(),
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = this.signer
      .getTronweb()
      .address.fromHex(receipt.contract_address);

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
  ): Promise<TronTransaction[]> {
    // NoopIsm has no mutable state
    return [];
  }
}
