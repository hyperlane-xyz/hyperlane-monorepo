import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

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
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getTestIsmConfig } from './ism-query.js';
import { getCreateNoopIsmTx } from './ism-tx.js';

export class RadixTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await getTestIsmConfig(this.gateway, address);

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

export class RadixTestIsmWriter
  extends RadixTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, TxReceipt[]]
  > {
    const transactionManifest = await getCreateNoopIsmTx(
      this.base,
      this.signer.getAddress(),
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(receipt);

    const deployedArtifact: ArtifactDeployed<
      TestIsmConfig,
      DeployedIsmAddress
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
    _artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedRadixTransaction[]> {
    // NoopIsm has no mutable state
    return [];
  }
}
