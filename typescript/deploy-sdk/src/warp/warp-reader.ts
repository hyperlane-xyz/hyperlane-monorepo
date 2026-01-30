import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import {
  Artifact,
  ArtifactReader,
  isArtifactDeployed,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  DeployedWarpAddress,
  DeployedWarpArtifact,
  DerivedWarpConfig,
  IRawWarpArtifactManager,
  WarpArtifactConfig,
  warpArtifactToDerivedConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { HookReader, createHookReader } from '../hook/hook-reader.js';
import { IsmReader, createIsmReader } from '../ism/generic-ism.js';

/**
 * Generic Warp Token Reader that can read any warp token type by detecting its type
 * and expanding nested ISM artifacts if present.
 */
export class WarpTokenReader
  implements ArtifactReader<WarpArtifactConfig, DeployedWarpAddress>
{
  protected readonly logger: Logger = rootLogger.child({
    module: WarpTokenReader.name,
  });

  protected readonly ismReader: IsmReader;
  protected readonly hookReader: HookReader;

  constructor(
    protected readonly artifactManager: IRawWarpArtifactManager,
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly chainLookup: ChainLookup,
  ) {
    this.ismReader = createIsmReader(chainMetadata, chainLookup);
    this.hookReader = createHookReader(chainMetadata, chainLookup);
  }

  async read(address: string): Promise<DeployedWarpArtifact> {
    // Read warp token via artifactManager - detects type and returns raw config
    const rawArtifact = await this.artifactManager.readWarpToken(address);

    // Expand nested ISM artifact if present
    const expandedIsmArtifact = await this.expandIsmArtifact(
      rawArtifact.config.interchainSecurityModule,
    );

    // Expand nested Hook artifact if present
    const expandedHookArtifact = await this.expandHookArtifact(
      rawArtifact.config.hook,
    );

    return {
      ...rawArtifact,
      config: {
        ...rawArtifact.config,
        interchainSecurityModule: expandedIsmArtifact,
        hook: expandedHookArtifact,
      },
    };
  }

  /**
   * Expands an ISM artifact by recursively reading it if underived.
   * Returns undefined if no ISM is configured.
   */
  private async expandIsmArtifact(
    ismArtifact?: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<DeployedIsmArtifact | undefined> {
    if (!ismArtifact) {
      return undefined;
    }

    // If ISM is underived (just an address), read it recursively to get full config
    if (isArtifactUnderived(ismArtifact)) {
      return this.ismReader.read(ismArtifact.deployed.address);
    }

    // If already a full deployed artifact, use as-is
    if (isArtifactDeployed(ismArtifact)) {
      return ismArtifact;
    }

    // NEW state should not occur in read artifacts
    throw new Error(
      `Unexpected ISM artifact state 'new' when reading warp token ISM configuration`,
    );
  }

  /**
   * Expands a Hook artifact by recursively reading it if underived.
   * Returns undefined if no Hook is configured.
   */
  private async expandHookArtifact(
    hookArtifact?: Artifact<HookArtifactConfig, DeployedHookAddress>,
  ): Promise<DeployedHookArtifact | undefined> {
    if (!hookArtifact) {
      return undefined;
    }

    // If Hook is underived (just an address), read it recursively to get full config
    if (isArtifactUnderived(hookArtifact)) {
      return this.hookReader.read(hookArtifact.deployed.address);
    }

    // If already a full deployed artifact, use as-is
    if (isArtifactDeployed(hookArtifact)) {
      return hookArtifact;
    }

    // NEW state should not occur in read artifacts
    throw new Error(
      `Unexpected Hook artifact state 'new' when reading warp token Hook configuration`,
    );
  }

  /**
   * Backward compatibility method that converts DeployedWarpArtifact to DerivedWarpConfig.
   * This allows WarpTokenReader to be used as a drop-in replacement for the old AltVMWarpRouteReader.
   */
  async deriveWarpConfig(address: string): Promise<DerivedWarpConfig> {
    const artifact = await this.read(address);
    return warpArtifactToDerivedConfig(artifact, this.chainLookup);
  }
}

/**
 * Factory function to create a WarpTokenReader instance.
 * This helper centralizes the creation of artifact managers and warp token readers,
 * making it easier to instantiate readers across the codebase.
 *
 * @param chainMetadata Chain metadata for the target chain (protocol type is extracted from metadata.protocol)
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @returns A WarpTokenReader instance
 *
 * @example
 * ```typescript
 * const reader = createWarpTokenReader(chainMetadata, chainLookup);
 * const warpConfig = await reader.read(warpTokenAddress);
 * ```
 */
export function createWarpTokenReader(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
): WarpTokenReader {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawWarpArtifactManager =
    protocolProvider.createWarpArtifactManager(chainMetadata);

  return new WarpTokenReader(artifactManager, chainMetadata, chainLookup);
}
