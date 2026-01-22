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

import { IIsmProvider } from '../interfaces/ism/ism-provider.js';
import { IIsmSigner } from '../interfaces/ism/ism-signer.js';

export class TestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(protected readonly query: IIsmProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await this.query.getNoopIsm({
      ismAddress: address,
    });

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

export class TestIsmWriter
  extends TestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: IIsmProvider,
    private readonly signer: IIsmSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<[ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, any[]]> {
    const { ismAddress, receipts } = await this.signer.createNoopIsm({});

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

    return [deployedArtifact, [...receipts]];
  }

  async update(
    _artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
  ): Promise<any[]> {
    return [];
  }
}
