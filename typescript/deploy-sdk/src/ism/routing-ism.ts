import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { objMap } from '@hyperlane-xyz/utils';

import { altVMIsmTypeToProviderSdkType } from '../utils/conversion.js';

export class AltVMRoutingIsmReader
  implements ArtifactReader<RoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    private readonly provider: IProvider,
    protected readonly artifactManager: IRawIsmArtifactManager,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<RoutingIsmArtifactConfig, DeployedIsmAddresses>> {
    const routingReader = this.artifactManager.createReader(
      AltVM.IsmType.ROUTING,
    );
    const { artifactState, config, deployed } =
      await routingReader.read(address);

    const domains: Record<
      number,
      Artifact<IsmArtifactConfig, DeployedIsmAddresses>
    > = {};

    for (const [domainId, ismAddress] of Object.entries(config.domains)) {
      const nestedIsm = await this.readDomainIsm(ismAddress);
      domains[parseInt(domainId)] = nestedIsm;
    }

    return {
      artifactState,
      config: {
        type: AltVM.IsmType.ROUTING,
        owner: config.owner,
        domains,
      },
      deployed,
    };
  }

  private async readDomainIsm(
    address: string,
  ): Promise<ArtifactDeployed<IsmArtifactConfig, DeployedIsmAddresses>> {
    const ismType = await this.provider.getIsmType({ ismAddress: address });

    const artifactIsmType = altVMIsmTypeToProviderSdkType(ismType);
    if (artifactIsmType === AltVM.IsmType.ROUTING) {
      return this.read(address);
    }

    const reader = this.artifactManager.createReader(artifactIsmType);
    return reader.read(address);
  }
}

export class AltVMRoutingIsmWriter
  extends AltVMRoutingIsmReader
  implements ArtifactWriter<RoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    provider: IProvider,
    artifactManager: IRawIsmArtifactManager,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
    private readonly accountAddress: string,
  ) {
    super(provider, artifactManager);
  }

  async create(
    artifact: Artifact<RoutingIsmArtifactConfig, DeployedIsmAddresses>,
  ): Promise<
    [
      ArtifactDeployed<RoutingIsmArtifactConfig, DeployedIsmAddresses>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    const deployedDomainIsms: Record<number, string> = {};
    for (const [domainId, nestedArtifact] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);

      if (nestedArtifact.artifactState === ArtifactState.DEPLOYED) {
        deployedDomainIsms[domain] = nestedArtifact.deployed.address;
      } else {
        const [deployedNested, receipts] =
          await this.deployDomainIsm(nestedArtifact);
        deployedDomainIsms[domain] = deployedNested.deployed.address;
        allReceipts.push(...receipts);
      }
    }

    const rawRoutingIsmWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
      this.accountAddress,
    );

    const rawRoutingConfig: Artifact<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddresses
    > = {
      config: {
        type: config.type,
        owner: config.owner,
        domains: deployedDomainIsms,
      },
    };

    const [deployedRoutingIsm, routingIsmReceipts] =
      await rawRoutingIsmWriter.create(rawRoutingConfig);
    allReceipts.push(...routingIsmReceipts);

    const deployedRoutingIsmConfig: ArtifactDeployed<
      RoutingIsmArtifactConfig,
      DeployedIsmAddresses
    > = {
      artifactState: deployedRoutingIsm.artifactState,
      config: {
        type: deployedRoutingIsm.config.type,
        owner: deployedRoutingIsm.config.owner,
        domains: objMap(deployedDomainIsms, (domainId, address) => ({
          artifactState: ArtifactState.DEPLOYED,
          config: config.domains[domainId].config,
          deployed: { address },
        })),
      },
      deployed: deployedRoutingIsm.deployed,
    };

    return [deployedRoutingIsmConfig, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<RoutingIsmArtifactConfig, DeployedIsmAddresses>,
  ): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;

    const deployedDomains: Record<number, string> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);

      if (domainIsmConfig.artifactState === ArtifactState.DEPLOYED) {
        deployedDomains[domain] = domainIsmConfig.deployed.address;
      } else {
        const [deployedNested] = await this.deployDomainIsm(domainIsmConfig);
        deployedDomains[domain] = deployedNested.deployed.address;
      }
    }

    const rawRoutingWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
      this.accountAddress,
    );

    const rawRoutingArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddresses
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: config.type,
        owner: config.owner,
        domains: deployedDomains,
      },
      deployed: deployed,
    };

    return rawRoutingWriter.update(rawRoutingArtifact);
  }

  private async deployDomainIsm(
    artifact: Artifact<IsmArtifactConfig, DeployedIsmAddresses>,
  ): Promise<
    [ArtifactDeployed<IsmArtifactConfig, DeployedIsmAddresses>, TxReceipt[]]
  > {
    if (artifact.artifactState === ArtifactState.DEPLOYED) {
      return [artifact, []];
    }

    const { config, artifactState } = artifact;
    if (config.type === AltVM.IsmType.ROUTING) {
      return this.create({
        config,
        artifactState,
      });
    }

    const writer = this.artifactManager.createWriter(
      config.type,
      this.signer,
      this.accountAddress,
    );

    return writer.create({
      config,
      artifactState,
    });
  }
}
