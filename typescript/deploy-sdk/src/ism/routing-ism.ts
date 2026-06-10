import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactState,
  ConfigOnChain,
  WithCompositionVariant,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
  RawDeployedIsmArtifact,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Logger, assert, rootLogger } from '@hyperlane-xyz/utils';

import { IsmReader } from './generic-ism.js';

type OrchestratedRoutingIsmArtifactConfig = WithCompositionVariant<
  RoutingIsmArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

/**
 * Post-deploy on-chain shape: ORCHESTRATED routing-ISM with children
 * collapsed to `ArtifactOnChain<>` via `ConfigOnChain`. Returned from
 * `read()` / `create()`.
 */
type DeployedRoutingIsmArtifact = ArtifactDeployed<
  ConfigOnChain<OrchestratedRoutingIsmArtifactConfig, DeployedIsmAddress>,
  DeployedIsmAddress
>;

export class RoutingIsmWriter {
  protected readonly logger: Logger = rootLogger.child({
    module: RoutingIsmWriter.name,
  });

  private readonly ismReader: IsmReader;

  constructor(
    protected readonly artifactManager: IRawIsmArtifactManager,
    protected readonly chainLookup: ChainLookup,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    this.ismReader = new IsmReader(artifactManager, chainLookup);
  }

  async read(address: string): Promise<DeployedRoutingIsmArtifact> {
    const artifact = await this.ismReader.read(address);
    const { config } = artifact;
    if (config.type !== AltVM.IsmType.ROUTING) {
      throw new Error(`Expected ROUTING ISM at ${address}, got ${config.type}`);
    }
    return {
      artifactState: artifact.artifactState,
      config,
      deployed: artifact.deployed,
    };
  }

  async create(
    artifact: ArtifactNew<OrchestratedRoutingIsmArtifactConfig>,
  ): Promise<[DeployedRoutingIsmArtifact, TxReceipt[]]> {
    const { config } = artifact;

    const rawRoutingIsmWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
    );
    assert(
      rawRoutingIsmWriter.composition === ArtifactComposition.ORCHESTRATED,
      `Routing ISM composition mismatch: config is '${ArtifactComposition.ORCHESTRATED}' but the protocol's raw routing-ISM writer is '${rawRoutingIsmWriter.composition}'`,
    );

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
        // UNDERIVED means predeployed ISM - just pass through without reading
        deployedDomainIsms[domain] = nestedArtifact;
      } else if (isArtifactNew(nestedArtifact)) {
        const [deployedNested, receipts] =
          await this.deployDomainIsm(nestedArtifact);
        deployedDomainIsms[domain] = deployedNested;
        allReceipts.push(...receipts);
      } else {
        throw new Error(
          `Unexpected EMBEDDED child under ORCHESTRATED routing ISM (domain ${domainId})`,
        );
      }
    }

    const rawRoutingConfig: Artifact<
      OrchestratedRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
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
        composition: ArtifactComposition.ORCHESTRATED,
        type: deployedRoutingIsm.config.type,
        owner: deployedRoutingIsm.config.owner,
        domains: deployedDomainIsms,
      },
      deployed: deployedRoutingIsm.deployed,
    };

    return [deployedRoutingIsmConfig, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<
      OrchestratedRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;

    const rawRoutingWriter = this.artifactManager.createWriter(
      AltVM.IsmType.ROUTING,
      this.signer,
    );
    assert(
      rawRoutingWriter.composition === ArtifactComposition.ORCHESTRATED,
      `Routing ISM composition mismatch: config is '${ArtifactComposition.ORCHESTRATED}' but the protocol's raw routing-ISM writer is '${rawRoutingWriter.composition}'`,
    );

    const updateTxs: AnnotatedTx[] = [];

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
          assert(
            config.composition === ArtifactComposition.ORCHESTRATED,
            `Unexpected EMBEDDED nested routing ISM under ORCHESTRATED parent (domain ${domainId})`,
          );
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
        // UNDERIVED means predeployed ISM - just pass through without reading
        deployedDomains[domain] = domainIsmConfig;
        // Note: We don't generate update transactions for UNDERIVED artifacts
        // since they represent existing ISMs that we're just referencing
      } else if (isArtifactNew(domainIsmConfig)) {
        [deployedDomains[domain]] = await this.deployDomainIsm(domainIsmConfig);
      } else {
        throw new Error(
          `Unexpected EMBEDDED child under ORCHESTRATED routing ISM (domain ${domainId})`,
        );
      }
    }

    const rawRoutingArtifact: ArtifactDeployed<
      OrchestratedRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
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
  ): Promise<[RawDeployedIsmArtifact, TxReceipt[]]> {
    const { config, artifactState } = artifact;
    if (config.type === AltVM.IsmType.ROUTING) {
      assert(
        config.composition === ArtifactComposition.ORCHESTRATED,
        'Unexpected EMBEDDED nested routing ISM under ORCHESTRATED parent',
      );
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
