import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactState,
  ConfigOnChain,
  WithCompositionVariant,
  isArtifactDeployed,
  isArtifactEmbedded,
  isArtifactNew,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedFeeAddress,
  DeployedFeeArtifact,
  FeeArtifactConfig,
  mergeFeeArtifacts,
  withFeeAssetConfig,
} from '@hyperlane-xyz/provider-sdk/fee';
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
  WarpArtifactConfig,
  buildFeeReadContextFromWarpArtifactConfig,
  resolveFeeTokenFromWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { createFeeWriter } from '../fee/fee-writer.js';
import { HookWriter, createHookWriter } from '../hook/hook-writer.js';
import { IsmWriter, createIsmWriter } from '../ism/generic-ism-writer.js';

import { WarpTokenReader } from './warp-reader.js';

type OrchestratedWarpArtifactConfig = WithCompositionVariant<
  WarpArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

/**
 * Post-deploy on-chain shape: ORCHESTRATED warp with composite children
 * collapsed via `ConfigOnChain`. Returned from `create()`.
 */
type OrchestratedDeployedWarpArtifact = ArtifactDeployed<
  ConfigOnChain<OrchestratedWarpArtifactConfig, DeployedWarpAddress>,
  DeployedWarpAddress
>;

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
export class WarpTokenWriter extends WarpTokenReader {
  protected readonly ismWriter: IsmWriter;
  protected readonly hookWriterFactory: (mailbox: string) => HookWriter;

  constructor(
    protected readonly artifactManager: IRawWarpArtifactManager,
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly chainLookup: ChainLookup,
    protected readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(artifactManager, chainMetadata, chainLookup);
    this.ismWriter = createIsmWriter(chainMetadata, chainLookup, signer);
    this.hookWriterFactory = (mailbox) =>
      createHookWriter(chainMetadata, chainLookup, signer, { mailbox });
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
  ): Promise<[OrchestratedDeployedWarpArtifact, TxReceipt[]]> {
    const { config } = artifact;
    if (config.composition !== ArtifactComposition.ORCHESTRATED) {
      throw new Error(
        'EMBEDDED warp artifact handling will be implemented in slice 5',
      );
    }
    const allReceipts: TxReceipt[] = [];
    if (config.hook) {
      assert(
        config.mailbox,
        'Mailbox is required when hook configuration is provided',
      );
    }

    // Deploy ISM if configured as a NEW artifact
    let onChainIsmArtifact:
      | ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
      | undefined;
    if (config.interchainSecurityModule) {
      if (isArtifactEmbedded(config.interchainSecurityModule)) {
        throw new Error('EMBEDDED ISM handling will be implemented in slice 5');
      }
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
      if (isArtifactEmbedded(config.hook)) {
        throw new Error(
          'EMBEDDED hook handling will be implemented in slice 5',
        );
      }
      if (!this.artifactManager.supportsHookUpdates()) {
        rootLogger.warn(
          'Hook configuration is not supported for this protocol. Hook configuration will be ignored.',
        );
      } else {
        const hookWriter = this.hookWriterFactory(config.mailbox);
        if (isArtifactNew(config.hook)) {
          const [deployedHook, hookReceipts] = await hookWriter.create(
            config.hook,
          );
          allReceipts.push(...hookReceipts);

          onChainHookArtifact = deployedHook;
        } else {
          onChainHookArtifact = config.hook;
        }
      }
    }

    // Deploy warp WITHOUT fee — the fee is deployed and attached post-warp
    // so that (a) the fee program can be initialized with the warp's
    // settlement asset already known (e.g. SVM synthetic mints, which only
    // exist post-deploy), and (b) the fee can be deployed with its real
    // owner from the start rather than via a signer-as-initial-owner /
    // TransferOwnership dance.
    const rawArtifact = {
      artifactState: ArtifactState.NEW,
      config: {
        ...config,
        composition: ArtifactComposition.ORCHESTRATED,
        interchainSecurityModule: onChainIsmArtifact,
        hook: onChainHookArtifact,
        fee: undefined,
      },
    };

    const writer = this.artifactManager.createWriter(config.type, this.signer);
    if (writer.composition !== ArtifactComposition.ORCHESTRATED) {
      throw new Error(
        'EMBEDDED warp writer handling will be implemented in slice 5',
      );
    }
    const [deployed, tokenReceipts] = await writer.create(rawArtifact);
    allReceipts.push(...tokenReceipts);

    // Deploy / resolve the fee now that the warp is on-chain and its
    // settlement asset is known.
    let onChainFeeArtifact:
      | ArtifactOnChain<FeeArtifactConfig, DeployedFeeAddress>
      | undefined;
    if (config.fee) {
      if (isArtifactEmbedded(config.fee)) {
        throw new Error('EMBEDDED fee handling will be implemented in slice 5');
      }
      const feeWriter = createFeeWriter(this.chainMetadata, this.signer, {
        knownRoutersPerDomain: buildFeeReadContextFromWarpArtifactConfig(
          deployed.config,
        ).knownRoutersPerDomain,
      });
      if (!feeWriter) {
        rootLogger.warn(
          'Fee programs are not supported for this protocol. Fee configuration will be ignored.',
        );
      } else if (isArtifactNew(config.fee)) {
        const feeAsset = resolveFeeTokenFromWarpArtifactConfig(deployed.config);
        const feeArtifactToCreate: ArtifactNew<FeeArtifactConfig> = {
          artifactState: ArtifactState.NEW,
          config: withFeeAssetConfig(config.fee.config, feeAsset),
        };
        const [deployedFee, feeReceipts] =
          await feeWriter.create(feeArtifactToCreate);
        allReceipts.push(...feeReceipts);
        onChainFeeArtifact = deployedFee;
      } else {
        onChainFeeArtifact = config.fee;
      }
    }

    // Attach the fee to the warp via the regular update path. The warp diff
    // emits the SetTokenFeeConfig tx (current=no-fee, expected=fee); the
    // fee writer's read sees current=expected since we just deployed it,
    // so no fee-program diff txs are emitted.
    if (onChainFeeArtifact) {
      const attachTxs = await this.update({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...config,
          interchainSecurityModule: onChainIsmArtifact,
          hook: onChainHookArtifact,
          fee: onChainFeeArtifact,
        },
        deployed: deployed.deployed,
      });
      for (const tx of attachTxs) {
        const receipt = await this.signer.sendAndConfirmTransaction(tx);
        allReceipts.push(receipt);
      }
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...deployed.config,
          interchainSecurityModule: onChainIsmArtifact,
          hook: onChainHookArtifact,
          fee: onChainFeeArtifact,
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
    if (config.composition !== ArtifactComposition.ORCHESTRATED) {
      throw new Error(
        'EMBEDDED warp artifact handling will be implemented in slice 5',
      );
    }
    const expectedHook = config.hook;
    if (expectedHook && !isArtifactUnderived(expectedHook)) {
      assert(
        config.mailbox,
        'Mailbox is required when hook configuration is provided',
      );
    }

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

    assert(
      isNullish(currentArtifact.config.fee) ||
        isArtifactDeployed(currentArtifact.config.fee),
      `Expected Warp Reader to expand the Fee config`,
    );

    const updateTxs: AnnotatedTx[] = [];

    // Resolve ISM updates
    const expectedIsm = config.interchainSecurityModule;
    const currentIsm = currentArtifact.config.interchainSecurityModule;

    let onChainIsmArtifact:
      | ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddress>
      | undefined;

    if (expectedIsm && !isArtifactUnderived(expectedIsm)) {
      if (isArtifactEmbedded(expectedIsm)) {
        throw new Error('EMBEDDED ISM handling will be implemented in slice 5');
      }
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
    const currentHook = currentArtifact.config.hook;

    let onChainHookArtifact:
      | ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>
      | undefined;

    if (expectedHook && !isArtifactUnderived(expectedHook)) {
      if (isArtifactEmbedded(expectedHook)) {
        throw new Error(
          'EMBEDDED hook handling will be implemented in slice 5',
        );
      }
      if (!this.artifactManager.supportsHookUpdates()) {
        rootLogger.warn(
          'Hook updates are not supported for this protocol. Hook configuration will be ignored.',
        );
        onChainHookArtifact = currentHook;
      } else {
        const hookWriter = this.hookWriterFactory(config.mailbox);

        // NEW or DEPLOYED: Merge with current and decide deploy vs update
        const mergedHookConfig = mergeHookArtifacts(currentHook, expectedHook);

        if (isArtifactNew(mergedHookConfig)) {
          // Deploy new Hook
          const [deployed] = await hookWriter.create(mergedHookConfig);

          onChainHookArtifact = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: deployed.deployed.address },
          };
        } else if (isArtifactDeployed(mergedHookConfig)) {
          // DEPLOYED: update existing Hook (or reuse if unchanged)
          const txs = await hookWriter.update(mergedHookConfig);

          updateTxs.push(...txs);
          onChainHookArtifact = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: mergedHookConfig.deployed.address },
          };
        }
      }
    } else {
      onChainHookArtifact = expectedHook;
    }

    // Resolve Fee updates
    const expectedFee = config.fee;
    const currentFee = currentArtifact.config.fee;

    let onChainFeeArtifact:
      | ArtifactOnChain<FeeArtifactConfig, DeployedFeeAddress>
      | undefined;

    if (expectedFee && !isArtifactUnderived(expectedFee)) {
      if (isArtifactEmbedded(expectedFee)) {
        throw new Error('EMBEDDED fee handling will be implemented in slice 5');
      }
      const feeContext = buildFeeReadContextFromWarpArtifactConfig(
        config,
        currentArtifact.config,
      );
      const feeWriter = createFeeWriter(
        this.chainMetadata,
        this.signer,
        feeContext,
      );

      if (!feeWriter) {
        rootLogger.warn(
          'Fee programs are not supported for this protocol. Fee configuration will be ignored.',
        );
        onChainFeeArtifact = currentFee;
      } else {
        const mergedFeeConfig = mergeFeeArtifacts(currentFee, expectedFee);
        // Prefer the freshly-read warp asset (synthetic warps populate it
        // post-deploy), falling back to the expected warp config when the
        // current read doesn't carry one.
        const feeAsset =
          resolveFeeTokenFromWarpArtifactConfig(currentArtifact.config) ??
          resolveFeeTokenFromWarpArtifactConfig(config);
        const mergedConfigWithAsset = withFeeAssetConfig(
          mergedFeeConfig.config,
          feeAsset,
        );

        if (isArtifactNew(mergedFeeConfig)) {
          const feeArtifactToCreate: ArtifactNew<FeeArtifactConfig> = {
            artifactState: ArtifactState.NEW,
            config: mergedConfigWithAsset,
          };
          const [deployedFee] = await feeWriter.create(feeArtifactToCreate);

          onChainFeeArtifact = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: deployedFee.deployed.address },
          };
        } else if (isArtifactDeployed(mergedFeeConfig)) {
          const feeArtifactToUpdate: DeployedFeeArtifact = {
            artifactState: ArtifactState.DEPLOYED,
            config: mergedConfigWithAsset,
            deployed: mergedFeeConfig.deployed,
          };
          const txs = await feeWriter.update(feeArtifactToUpdate);

          updateTxs.push(...txs);
          onChainFeeArtifact = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: mergedFeeConfig.deployed.address },
          };
        }
      }
    } else {
      onChainFeeArtifact = expectedFee;
    }

    // Build raw artifact with flattened ISM, Hook, and Fee references
    const rawArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        ...config,
        composition: ArtifactComposition.ORCHESTRATED,
        interchainSecurityModule: onChainIsmArtifact,
        hook: onChainHookArtifact,
        fee: onChainFeeArtifact,
      },
      deployed,
    };

    // Delegate to protocol-specific writer which will read current state and compare
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    if (writer.composition !== ArtifactComposition.ORCHESTRATED) {
      throw new Error(
        'EMBEDDED warp writer handling will be implemented in slice 5',
      );
    }

    const warpUpdateTxs = await writer.update(rawArtifact);
    updateTxs.push(...warpUpdateTxs);

    return updateTxs;
  }
}
