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

/**
 * Result of applying an ISM update operation.
 *
 * This type captures the three possible outcomes:
 * - 'noop': No changes needed - config unchanged for immutable ISM
 * - 'create': New ISM was deployed - type changed or immutable config changed
 * - 'update': Existing ISM was updated in-place - mutable ISM config changed
 */
export type ApplyUpdateResult =
  | { action: 'noop'; deployed: DeployedIsmArtifact }
  | { action: 'create'; deployed: DeployedIsmArtifact; receipts: TxReceipt[] }
  | { action: 'update'; deployed: DeployedIsmArtifact; txs: AnnotatedTx[] };

/**
 * Interface for IsmWriter to avoid circular dependency.
 * RoutingIsmWriter needs to call IsmWriter for nested ISM operations,
 * but IsmWriter creates RoutingIsmWriter.
 */
export interface IIsmWriter {
  create(
    artifact: ArtifactNew<IsmArtifactConfig>,
  ): Promise<[DeployedIsmArtifact, TxReceipt[]]>;

  /**
   * @deprecated Use applyUpdate() or applyUpdateWith() instead.
   * This method is artifact-state-driven and will be removed after Artifact API update.
   */
  update(artifact: DeployedIsmArtifact): Promise<AnnotatedTx[]>;

  /**
   * Reads current ISM state from chain and applies update.
   * @param currentAddress Address of the deployed ISM
   * @param desired Desired ISM configuration
   */
  applyUpdate(
    currentAddress: string,
    desired: ArtifactNew<IsmArtifactConfig>,
  ): Promise<ApplyUpdateResult>;

  /**
   * Applies update using provided current state (avoids redundant chain read).
   * @param current Current deployed ISM artifact (already read from chain)
   * @param desired Desired ISM configuration
   */
  applyUpdateWith(
    current: DeployedIsmArtifact,
    desired: ArtifactNew<IsmArtifactConfig>,
  ): Promise<ApplyUpdateResult>;
}

export class RoutingIsmWriter
  implements ArtifactWriter<RoutingIsmArtifactConfig, DeployedIsmAddress>
{
  protected readonly logger: Logger = rootLogger.child({
    module: RoutingIsmWriter.name,
  });

  private readonly ismReader: IsmReader;
  private readonly ismWriter: IIsmWriter;

  constructor(
    protected readonly artifactManager: IRawIsmArtifactManager,
    protected readonly chainLookup: ChainLookup,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
    ismWriter: IIsmWriter,
  ) {
    this.ismReader = new IsmReader(artifactManager, chainLookup);
    this.ismWriter = ismWriter;
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
        // UNDERIVED means predeployed ISM - just pass through without reading
        deployedDomainIsms[domain] = nestedArtifact;
      } else if (isArtifactNew(nestedArtifact)) {
        const [deployedNested, receipts] =
          await this.ismWriter.create(nestedArtifact);
        deployedDomainIsms[domain] = deployedNested;
        allReceipts.push(...receipts);
      } else {
        // This should never happen - all artifact states are handled above
        const _exhaustiveCheck: never = nestedArtifact;
        this.logger.error(
          `Unexpected artifact state ${(_exhaustiveCheck as any).artifactState} for domain ${domainId}`,
        );
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

  /**
   * @deprecated Use applyUpdate() or applyUpdateWith() instead.
   * This method is artifact-state-driven and will be removed after Artifact API update.
   */
  async update(artifact: DeployedRoutingIsmArtifact): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;

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
        // Use applyUpdate() for nested ISMs to get proper type/config change detection
        // and the correct resulting address (which may be new if ISM was recreated)
        const result = await this.ismWriter.applyUpdate(
          domainIsmConfig.deployed.address,
          { config: domainIsmConfig.config },
        );

        if (result.action === 'update') {
          updateTxs.push(...result.txs);
        }

        // Use the address from the result - it may be different if a new ISM was created
        deployedDomains[domain] = result.deployed;
      } else if (isArtifactUnderived(domainIsmConfig)) {
        // UNDERIVED means predeployed ISM - just pass through without reading
        deployedDomains[domain] = domainIsmConfig;
        // Note: We don't generate update transactions for UNDERIVED artifacts
        // since they represent existing ISMs that we're just referencing
      } else if (isArtifactNew(domainIsmConfig)) {
        [deployedDomains[domain]] =
          await this.ismWriter.create(domainIsmConfig);
      } else {
        // This should never happen - all artifact states are handled above
        const _exhaustiveCheck: never = domainIsmConfig;
        this.logger.error(
          `Unexpected artifact state ${(_exhaustiveCheck as any).artifactState} for domain ${domainId}`,
        );
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

  /**
   * Reads current routing ISM state from chain and applies update.
   * This is the preferred method - it compares by domain ID, not artifact state.
   */
  async applyUpdate(
    currentAddress: string,
    desired: ArtifactNew<RoutingIsmArtifactConfig>,
  ): Promise<ApplyUpdateResult> {
    const current = await this.read(currentAddress);
    return this.applyUpdateWith(current, desired);
  }

  /**
   * Applies routing ISM update using provided current state (avoids redundant chain read).
   *
   * This method is domain-ID driven:
   * - For each desired domain, checks if it exists in current state
   * - Existing domains: calls applyUpdate() to compare configs (may noop or recreate)
   * - New domains: calls create()
   */
  async applyUpdateWith(
    current: DeployedRoutingIsmArtifact,
    desired: ArtifactNew<RoutingIsmArtifactConfig>,
  ): Promise<ApplyUpdateResult> {
    const { config: desiredConfig } = desired;
    const currentDomains = current.config.domains;

    const updateTxs: AnnotatedTx[] = [];
    const deployedDomains: Record<
      number,
      ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
    > = {};

    for (const [domainIdStr, desiredDomainArtifact] of Object.entries(
      desiredConfig.domains,
    )) {
      const domainId = parseInt(domainIdStr);

      if (!this.chainLookup.getChainName(domainId)) {
        this.logger.warn(
          `Skipping update of unknown ${AltVM.IsmType.ROUTING} domain ${domainId}`,
        );
        continue;
      }

      const currentDomain = currentDomains[domainId];

      // Extract the nested config - handle all artifact states
      const desiredNestedConfig =
        'config' in desiredDomainArtifact
          ? desiredDomainArtifact.config
          : undefined;

      // Check if domain exists on-chain (has deployed address)
      const currentDomainAddress =
        currentDomain && 'deployed' in currentDomain
          ? currentDomain.deployed.address
          : undefined;

      if (currentDomainAddress && desiredNestedConfig) {
        // Domain exists on-chain - use applyUpdate to compare configs
        const result = await this.ismWriter.applyUpdate(currentDomainAddress, {
          config: desiredNestedConfig,
        });

        if (result.action === 'update') {
          updateTxs.push(...result.txs);
        }

        deployedDomains[domainId] = result.deployed;
      } else if (desiredNestedConfig) {
        // Domain is new - create it
        const [deployed] = await this.ismWriter.create({
          config: desiredNestedConfig,
        });
        deployedDomains[domainId] = deployed;
      } else if ('deployed' in desiredDomainArtifact) {
        // UNDERIVED - pass through without reading
        deployedDomains[domainId] = desiredDomainArtifact;
      }
    }

    // Update the raw routing ISM with enrolled domains
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
        type: desiredConfig.type,
        owner: desiredConfig.owner,
        domains: deployedDomains,
      },
      deployed: current.deployed,
    };

    const routingUpdateTxs = await rawRoutingWriter.update(rawRoutingArtifact);

    return {
      action: 'update',
      deployed: {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: desiredConfig.type,
          owner: desiredConfig.owner,
          domains: deployedDomains,
        },
        deployed: current.deployed,
      },
      txs: [...updateTxs, ...routingUpdateTxs],
    };
  }
}
