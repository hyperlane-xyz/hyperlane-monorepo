import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddresses,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
  altVMIsmTypeToProviderSdkType,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

type DeployedRoutingIsmArtifact = ArtifactDeployed<
  RoutingIsmArtifactConfig,
  DeployedIsmAddresses
>;

export class RoutingIsmReader
  implements ArtifactReader<RoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  protected readonly logger: Logger = rootLogger.child({
    module: RoutingIsmReader.name,
  });

  constructor(
    protected readonly chainLookup: ChainLookup,
    private readonly provider: IProvider,
    protected readonly artifactManager: IRawIsmArtifactManager,
  ) {}

  async read(address: string): Promise<DeployedRoutingIsmArtifact> {
    const routingReader = this.artifactManager.createReader(
      AltVM.IsmType.ROUTING,
    );
    const { artifactState, config, deployed } =
      await routingReader.read(address);

    const domains: Record<number, DeployedIsmArtifact> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getDomainId(domainId)) {
        this.logger.warn(
          `Skipping derivation of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );

        continue;
      }

      let nestedIsm;
      if (domainIsmConfig.artifactState === ArtifactState.DEPLOYED) {
        nestedIsm = domainIsmConfig;
      } else {
        nestedIsm = await this.readDomainIsm(domainIsmConfig.deployed.address);
      }

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

  private async readDomainIsm(address: string): Promise<DeployedIsmArtifact> {
    const ismType = await this.provider.getIsmType({ ismAddress: address });

    const artifactIsmType = altVMIsmTypeToProviderSdkType(ismType);
    if (artifactIsmType === AltVM.IsmType.ROUTING) {
      return this.read(address);
    }

    const reader = this.artifactManager.createReader(artifactIsmType);
    return reader.read(address);
  }
}

export class RoutingIsmWriter
  extends RoutingIsmReader
  implements ArtifactWriter<RoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    provider: IProvider,
    artifactManager: IRawIsmArtifactManager,
    chainLookup: ChainLookup,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(chainLookup, provider, artifactManager);
  }

  async create(
    artifact: Artifact<RoutingIsmArtifactConfig, DeployedIsmAddresses>,
  ): Promise<[DeployedRoutingIsmArtifact, TxReceipt[]]> {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    const deployedDomainIsms: Record<number, DeployedIsmArtifact> = {};
    for (const [domainId, nestedArtifact] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);

      if (nestedArtifact.artifactState === ArtifactState.DEPLOYED) {
        deployedDomainIsms[domain] = nestedArtifact;
      } else {
        const [deployedNested, receipts] =
          await this.deployDomainIsm(nestedArtifact);
        deployedDomainIsms[domain] = deployedNested;
        allReceipts.push(...receipts);
      }
    }

    const rawRoutingIsmWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
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

    const deployedRoutingIsmConfig: DeployedRoutingIsmArtifact = {
      artifactState: deployedRoutingIsm.artifactState,
      config: {
        type: deployedRoutingIsm.config.type,
        owner: deployedRoutingIsm.config.owner,
        domains: deployedDomainIsms,
      },
      deployed: deployedRoutingIsm.deployed,
    };

    return [deployedRoutingIsmConfig, allReceipts];
  }

  async update(artifact: DeployedRoutingIsmArtifact): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;

    const updateTxs = [];

    const deployedDomains: Record<number, DeployedIsmArtifact> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getDomainId(domainId)) {
        this.logger.warn(
          `Skipping update of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );

        continue;
      }

      const domain = parseInt(domainId);

      if (domainIsmConfig.artifactState === ArtifactState.DEPLOYED) {
        const { artifactState, config, deployed } = domainIsmConfig;

        const domainIsmWriter = this.artifactManager.createWriter(
          domainIsmConfig.config.type,
          this.signer,
        );

        let domainIsmUpdateTxs: AnnotatedTx[];
        if (config.type === AltVM.IsmType.ROUTING) {
          domainIsmUpdateTxs = await this.update({
            artifactState,
            config,
            deployed,
          });
        } else {
          domainIsmUpdateTxs = await domainIsmWriter.update({
            artifactState,
            config,
            deployed,
          });
        }
        updateTxs.push(...domainIsmUpdateTxs);

        deployedDomains[domain] = domainIsmConfig;
      } else {
        [deployedDomains[domain]] = await this.deployDomainIsm(domainIsmConfig);
      }
    }

    const rawRoutingWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
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
  ): Promise<[DeployedIsmArtifact, TxReceipt[]]> {
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

    const writer = this.artifactManager.createWriter(config.type, this.signer);

    return writer.create({
      config,
      artifactState,
    });
  }
}
