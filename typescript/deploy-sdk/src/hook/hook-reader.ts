import {
  ChainMetadataForAltVM,
  ProtocolArtifactManagerContext,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ArtifactReader } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  DeployedRawHookArtifact,
  DerivedHookConfig,
  HookArtifactConfig,
  IRawHookArtifactManager,
  hookArtifactToDerivedConfig,
  isDirectHookArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { Logger, assert, rootLogger } from '@hyperlane-xyz/utils';

/**
 * Factory function to create a HookReader instance.
 * This helper centralizes the creation of artifact managers and hook readers,
 * making it easier to instantiate readers across the codebase.
 *
 * @param chainMetadata Chain metadata for the target chain
 * @param chainLookup Chain lookup interface for resolving chain names and domain IDs
 * @param context Optional known addresses for the target chain
 * @returns A HookReader instance
 *
 * @example
 * ```typescript
 * const reader = createHookReader(chainMetadata, chainLookup, {
 *   addresses: { mailbox: mailboxAddress },
 * });
 * const hookConfig = await reader.read(hookAddress);
 * ```
 */
export function createHookReader(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  context?: ProtocolArtifactManagerContext,
): HookReader {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawHookArtifactManager =
    protocolProvider.createHookArtifactManager(chainMetadata, context);

  return new HookReader(artifactManager, chainLookup);
}

/**
 * Generic Hook Reader that can read direct hook types by detecting their type.
 * Nested hook expansion is not yet supported.
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
    const artifact: DeployedRawHookArtifact =
      await this.artifactManager.readHook(address);
    assert(
      isDirectHookArtifactConfig(artifact.config),
      `Nested hook artifact type ${artifact.config.type} is not yet supported by HookReader`,
    );

    return artifact;
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
