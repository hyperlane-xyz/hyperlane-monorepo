import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
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
  DeployedHookAddress,
  HookArtifactConfig,
  mergeHookArtifacts,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  DeployedIsmAddress,
  IsmArtifactConfig,
  mergeIsmArtifacts,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedWarpAddress,
  DeployedWarpArtifact,
  IRawWarpArtifactManager,
  RawWarpArtifactConfig,
  WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import { HookWriter, createHookWriter } from '../hook/hook-writer.js';
import { IsmWriter, createIsmWriter } from '../ism/generic-ism-writer.js';

import { WarpTokenReader } from './warp-reader.js';

/**
 * Factory function to create a WarpTokenWriter instance.
 *
 * @param chainMetadata Chain metadata for the target chain
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @param signer Signer interface for signing transactions
 * @returns A WarpTokenWriter instance
 *
 * @example
 * ```typescript
 * const writer = createWarpTokenWriter(chainMetadata, chainLookup, signer);
 * const [deployed, receipts] = await writer.create(warpArtifact);
 * ```
 */
export function createWarpTokenWriter(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  signer: ISigner<AnnotatedTx, TxReceipt>,
): WarpTokenWriter {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawWarpArtifactManager =
    protocolProvider.createWarpArtifactManager(chainMetadata);

  return new WarpTokenWriter(
    artifactManager,
    chainMetadata,
    chainLookup,
    signer,
  );
}

/**
 * WarpTokenWriter handles creation and updates of warp tokens using the Artifact API.
 * It delegates to protocol-specific artifact writers for individual warp token types.
 *
 * Key features:
 * - Extends WarpTokenReader to inherit read() functionality
 * - Works with pure Artifact API (WarpArtifactConfig)
 * - Handles nested ISM deployment before warp token deployment
 * - Delegates to typed writers from artifact manager for specific warp token types
 * - Protocol-agnostic through artifact manager abstraction
 */
export class WarpTokenWriter
  extends WarpTokenReader
  implements ArtifactWriter<WarpArtifactConfig, DeployedWarpAddress>
{
  protected readonly ismWriter: IsmWriter;
  protected readonly hookWriter: HookWriter;

  constructor(
    protected readonly artifactManager: IRawWarpArtifactManager,
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly chainLookup: ChainLookup,
    protected readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(artifactManager, chainMetadata, chainLookup);
    this.ismWriter = createIsmWriter(chainMetadata, chainLookup, signer);
    this.hookWriter = createHookWriter(chainMetadata, chainLookup, signer);
  }

  /**
   * Creates a new warp token by deploying it on-chain.
   * If the warp token has a nested ISM artifact, deploys the ISM first.
   *
   * @param artifact The warp token configuration to deploy
   * @returns A tuple of [deployed artifact, transaction receipts]
   */
  async create(
    artifact: ArtifactNew<WarpArtifactConfig>,
  ): Promise<[DeployedWarpArtifact, TxReceipt[]]> {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    // Deploy ISM if configured as a NEW artifact
    let onChainIsmArtifact:
      | ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
      | undefined;
    if (config.interchainSecurityModule) {
      if (isArtifactNew(config.interchainSecurityModule)) {
        const [deployedIsm, ismReceipts] = await this.ismWriter.create(
          config.interchainSecurityModule,
        );
        allReceipts.push(...ismReceipts);

        onChainIsmArtifact = deployedIsm;
      } else {
        onChainIsmArtifact = config.interchainSecurityModule;
      }
    }

    // Deploy Hook if configured as a NEW artifact
    let onChainHookArtifact:
      | ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>
      | undefined;
    if (config.hook) {
      if (isArtifactNew(config.hook)) {
        const [deployedHook, hookReceipts] = await this.hookWriter.create(
          config.hook,
        );
        allReceipts.push(...hookReceipts);

        onChainHookArtifact = deployedHook;
      } else {
        onChainHookArtifact = config.hook;
      }
    }

    // Convert to raw artifact config (flatten nested artifacts)
    const rawArtifact: ArtifactNew<RawWarpArtifactConfig> = {
      artifactState: ArtifactState.NEW,
      config: {
        ...config,
        interchainSecurityModule: onChainIsmArtifact,
        hook: onChainHookArtifact,
      },
    };

    // Delegate to protocol-specific writer
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    const [deployed, tokenReceipts] = await writer.create(rawArtifact);
    allReceipts.push(...tokenReceipts);

    // Return deployed config
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...artifact.config,
          interchainSecurityModule: onChainIsmArtifact,
          hook: onChainHookArtifact,
        },
        deployed: deployed.deployed,
      },
      allReceipts,
    ];
  }

  /**
   * Updates an existing warp token to match the desired configuration.
   * Warp tokens are mutable - supports remote router enrollment/unenrollment,
   * ISM updates, and owner changes.
   *
   * The protocol-specific writer will read the current on-chain state and compare
   * with the expected config to generate the necessary update transactions.
   *
   * @param artifact The desired warp token state (must include deployed address)
   * @returns Array of transactions needed to perform the update
   * @throws Error if the token type cannot be changed (e.g., collateral -> synthetic)
   */
  async update(artifact: DeployedWarpArtifact): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;

    // Read current on-chain state to verify token type hasn't changed
    const currentArtifact = await this.read(deployed.address);
    assert(
      currentArtifact.config.type === config.type,
      `Cannot change warp token type from '${currentArtifact.config.type}' to '${config.type}'. ` +
        `Token type is immutable after deployment.`,
    );

    assert(
      isNullish(currentArtifact.config.interchainSecurityModule) ||
        isArtifactDeployed(currentArtifact.config.interchainSecurityModule),
      `Expected Warp Reader to expand the ISM config`,
    );

    assert(
      isNullish(currentArtifact.config.hook) ||
        isArtifactDeployed(currentArtifact.config.hook),
      `Expected Warp Reader to expand the Hook config`,
    );

    const updateTxs: AnnotatedTx[] = [];

    // Resolve ISM updates
    const expectedIsm = config.interchainSecurityModule;
    const currentIsm = currentArtifact.config.interchainSecurityModule;

    let onChainIsmArtifact:
      | ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
      | undefined;

    if (expectedIsm && !isArtifactUnderived(expectedIsm)) {
      // NEW or DEPLOYED: Merge with current and decide deploy vs update
      const mergedIsmConfig = mergeIsmArtifacts(currentIsm, expectedIsm);

      if (isArtifactNew(mergedIsmConfig)) {
        // Deploy new ISM
        const [deployed] = await this.ismWriter.create(mergedIsmConfig);

        onChainIsmArtifact = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: deployed.deployed.address },
        };
      } else if (isArtifactDeployed(mergedIsmConfig)) {
        // DEPLOYED: update existing ISM (or reuse if unchanged)
        const txs = await this.ismWriter.update(mergedIsmConfig);

        updateTxs.push(...txs);
        onChainIsmArtifact = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mergedIsmConfig.deployed.address },
        };
      }
    } else {
      onChainIsmArtifact = expectedIsm;
    }

    // Resolve Hook updates
    const expectedHook = config.hook;
    const currentHook = currentArtifact.config.hook;

    let onChainHookArtifact:
      | ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>
      | undefined;

    if (expectedHook && !isArtifactUnderived(expectedHook)) {
      // NEW or DEPLOYED: Merge with current and decide deploy vs update
      const mergedHookConfig = mergeHookArtifacts(currentHook, expectedHook);

      if (isArtifactNew(mergedHookConfig)) {
        // Deploy new Hook
        const [deployed] = await this.hookWriter.create(mergedHookConfig);

        onChainHookArtifact = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: deployed.deployed.address },
        };
      } else if (isArtifactDeployed(mergedHookConfig)) {
        // DEPLOYED: update existing Hook (or reuse if unchanged)
        const txs = await this.hookWriter.update(mergedHookConfig);

        updateTxs.push(...txs);
        onChainHookArtifact = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mergedHookConfig.deployed.address },
        };
      }
    } else {
      onChainHookArtifact = expectedHook;
    }

    // Build raw artifact with flattened ISM and Hook references
    const rawArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        ...config,
        interchainSecurityModule: onChainIsmArtifact,
        hook: onChainHookArtifact,
      },
      deployed,
    };

    // Delegate to protocol-specific writer which will read current state and compare
    const writer = this.artifactManager.createWriter(config.type, this.signer);

    const warpUpdateTxs = await writer.update(rawArtifact);
    updateTxs.push(...warpUpdateTxs);

    return updateTxs;
  }
}
