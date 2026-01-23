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

import { AltVM } from '../../index.js';

export class TestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(protected readonly provider: AltVM.IProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const ismConfig = await this.provider.getNoopIsm({
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
    provider: AltVM.IProvider,
    private readonly signer: AltVM.ISigner<any, any>,
  ) {
    super(provider);
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
