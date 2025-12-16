import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
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
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { GenericIsmReader } from './generic-ism.js';

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

  private readonly genericIsmReader: GenericIsmReader;

  constructor(
    protected readonly chainLookup: ChainLookup,
    protected readonly artifactManager: IRawIsmArtifactManager,
    genericIsmReader?: GenericIsmReader,
  ) {
    // If genericIsmReader is provided, use it (called from GenericIsmReader)
    // Otherwise create a new one (called directly or from RoutingIsmWriter)
    this.genericIsmReader =
      genericIsmReader ?? new GenericIsmReader(artifactManager, chainLookup);
  }

  /**
   * Convenience method for reading routing ISMs directly.
   * Delegates to GenericIsmReader which handles type detection.
   */
  async read(address: string): Promise<DeployedRoutingIsmArtifact> {
    return this.genericIsmReader.read(
      address,
    ) as Promise<DeployedRoutingIsmArtifact>;
  }

  /**
   * Expands a raw routing ISM config by recursively reading the domain ISMs.
   * Takes a pre-read raw artifact to avoid double reading.
   */
  async expandFromRaw(
    rawArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddresses
    >,
  ): Promise<DeployedRoutingIsmArtifact> {
    const { artifactState, config, deployed } = rawArtifact;
    const domains: Record<number, DeployedIsmArtifact> = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getDomainId(domainId)) {
        this.logger.warn(
          `Skipping derivation of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );
        continue;
      }

      let nestedIsm: DeployedIsmArtifact;
      if (domainIsmConfig.artifactState === ArtifactState.DEPLOYED) {
        // Already a full deployed artifact, use as-is
        nestedIsm = domainIsmConfig as DeployedIsmArtifact;
      } else {
        // ArtifactUnderived - recursively read using generic reader to get full config
        nestedIsm = await this.genericIsmReader.read(
          domainIsmConfig.deployed.address,
        );
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
}

export class RoutingIsmWriter
  extends RoutingIsmReader
  implements ArtifactWriter<RoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    chainLookup: ChainLookup,
    artifactManager: IRawIsmArtifactManager,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(chainLookup, artifactManager);
  }

  async create(
    artifact: ArtifactNew<RoutingIsmArtifactConfig>,
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
