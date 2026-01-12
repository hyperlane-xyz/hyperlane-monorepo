import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactState,
  ArtifactWriter,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { IsmReader } from './generic-ism.js';

type DeployedRoutingIsmArtifact = ArtifactDeployed<
  RoutingIsmArtifactConfig,
  DeployedIsmAddress
>;

export class RoutingIsmWriter
  implements ArtifactWriter<RoutingIsmArtifactConfig, DeployedIsmAddress>
{
  protected readonly logger: Logger = rootLogger.child({
    module: RoutingIsmWriter.name,
  });

  private readonly ismReader: IsmReader;

  constructor(
    protected readonly chainLookup: ChainLookup,
    protected readonly artifactManager: IRawIsmArtifactManager,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    this.ismReader = new IsmReader(artifactManager, chainLookup);
  }

  async read(address: string): Promise<DeployedRoutingIsmArtifact> {
    const artifact = await this.ismReader.read(address);
    if (artifact.config.type !== AltVM.IsmType.ROUTING) {
      throw new Error(
        `Expected ROUTING ISM at ${address}, got ${artifact.config.type}`,
      );
    }
    return artifact as DeployedRoutingIsmArtifact;
  }

  async create(
    artifact: ArtifactNew<RoutingIsmArtifactConfig>,
  ): Promise<[DeployedRoutingIsmArtifact, TxReceipt[]]> {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    const deployedDomainIsms: Record<
      number,
      ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
    > = {};
    for (const [domainId, nestedArtifact] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);

      if (isArtifactDeployed(nestedArtifact)) {
        deployedDomainIsms[domain] = nestedArtifact;
      } else if (isArtifactUnderived(nestedArtifact)) {
        // Already deployed on-chain, pass through as-is
        deployedDomainIsms[domain] = nestedArtifact;
      } else if (isArtifactNew(nestedArtifact)) {
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
      DeployedIsmAddress
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

    const deployedDomains: Record<
      number,
      ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
    > = {};

    for (const [domainId, domainIsmConfig] of Object.entries(config.domains)) {
      if (!this.chainLookup.getChainName(parseInt(domainId))) {
        this.logger.warn(
          `Skipping update of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );

        continue;
      }

      const domain = parseInt(domainId);

      if (isArtifactDeployed(domainIsmConfig)) {
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
      } else if (isArtifactUnderived(domainIsmConfig)) {
        // Already deployed on-chain but config unknown, pass through as-is
        // (no update possible without config)
        deployedDomains[domain] = domainIsmConfig;
      } else if (isArtifactNew(domainIsmConfig)) {
        [deployedDomains[domain]] = await this.deployDomainIsm(domainIsmConfig);
      }
    }

    const rawRoutingWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
    );

    const rawRoutingArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: config.type,
        owner: config.owner,
        domains: deployedDomains,
      },
      deployed: deployed,
    };

    const routingUpdateTxs = await rawRoutingWriter.update(rawRoutingArtifact);
    return [...updateTxs, ...routingUpdateTxs];
  }

  private async deployDomainIsm(
    artifact: ArtifactNew<IsmArtifactConfig>,
  ): Promise<[DeployedIsmArtifact, TxReceipt[]]> {
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
