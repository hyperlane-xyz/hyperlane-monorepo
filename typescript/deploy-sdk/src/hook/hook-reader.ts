import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ArtifactReader } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  DerivedHookConfig,
  HookArtifactConfig,
  IRawHookArtifactManager,
  hookArtifactToDerivedConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

/**
 * Factory function to create a HookReader instance.
 * This helper centralizes the creation of artifact managers and hook readers,
 * making it easier to instantiate readers across the codebase.
 *
 * @param chainMetadata Chain metadata for the target chain (protocol type is extracted from metadata.protocol)
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @returns A HookReader instance
 *
 * @example
 * ```typescript
 * const reader = createHookReader(chainMetadata, chainLookup);
 * const hookConfig = await reader.read(hookAddress);
 * ```
 */
export function createHookReader(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
): HookReader {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawHookArtifactManager =
    protocolProvider.createHookArtifactManager(chainMetadata);

  return new HookReader(artifactManager, chainLookup);
}

/**
 * Generic Hook Reader that can read any hook type by detecting its type.
 * Unlike ISMs, hooks don't have composite/nested types, so no recursive expansion needed.
 */
export class HookReader implements ArtifactReader<
  HookArtifactConfig,
  DeployedHookAddress
> {
  protected readonly logger: Logger = rootLogger.child({
    module: HookReader.name,
  });

  constructor(
    protected readonly artifactManager: IRawHookArtifactManager,
    protected readonly chainLookup: ChainLookup,
  ) {}

  async read(address: string): Promise<DeployedHookArtifact> {
    // Read hook via artifactManager - detects type and returns config
    return this.artifactManager.readHook(address);
  }

  /**
   * Backward compatibility method that converts DeployedHookArtifact to DerivedHookConfig.
   * This allows HookReader to be used as a drop-in replacement for the old AltVMHookReader.
   */
  async deriveHookConfig(address: string): Promise<DerivedHookConfig> {
    const artifact = await this.read(address);
    return hookArtifactToDerivedConfig(artifact, this.chainLookup);
  }
}
