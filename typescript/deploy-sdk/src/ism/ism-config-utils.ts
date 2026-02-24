import {
  Artifact,
  ArtifactNew,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  IsmArtifactConfig,
  IsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

// Re-export ISM utility functions from provider-sdk for convenience
export { shouldDeployNewIsm } from '@hyperlane-xyz/provider-sdk/ism';

/**
 * Converts IsmConfig (Config API) to IsmArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - String chain names → numeric domain IDs (for routing ISM domains)
 * - Address string references → ArtifactUnderived objects
 * - Recursively handles nested routing ISM configurations
 * - Other ISM types (multisig, testIsm) pass through unchanged
 *
 * @param config The ISM configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @returns Artifact wrapper around IsmArtifactConfig suitable for artifact writers
 *
 * @example
 * ```typescript
 * // Config API format
 * const ismConfig: IsmConfig = {
 *   type: 'domainRoutingIsm',
 *   owner: '0x123...',
 *   domains: {
 *     ethereum: { type: 'merkleRootMultisigIsm', validators: [...], threshold: 2 },
 *     polygon: '0xabc...' // address reference
 *   }
 * };
 *
 * // Convert to Artifact API format
 * const artifact = ismConfigToArtifact(ismConfig, chainLookup);
 * // artifact.config.domains is now Record<number, Artifact<IsmArtifactConfig>>
 * // with numeric domain IDs and properly wrapped nested configs
 * ```
 */
export function ismConfigToArtifact(
  config: IsmConfig,
  chainLookup: ChainLookup,
): ArtifactNew<IsmArtifactConfig> {
  // Handle routing ISMs - need to convert chain names to domain IDs
  if (config.type === 'domainRoutingIsm') {
    const domains: Record<
      number,
      Artifact<IsmArtifactConfig, DeployedIsmAddress>
    > = {};

    for (const [chainName, nestedConfig] of Object.entries(config.domains)) {
      const domainId = chainLookup.getDomainId(chainName);
      if (!domainId) {
        // Skip unknown chains - they'll be warned about during deployment
        continue;
      }

      if (typeof nestedConfig === 'string') {
        // Address reference - create an UNDERIVED artifact
        // This represents a predeployed ISM with unspecified type
        // The routing ISM writer will pass it through without reading
        // Only readers will fetch its config from chain if needed
        domains[domainId] = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: nestedConfig },
        };
      } else {
        // Nested ISM config - recursively convert
        domains[domainId] = ismConfigToArtifact(nestedConfig, chainLookup);
      }
    }

    return {
      config: {
        type: 'domainRoutingIsm',
        owner: config.owner,
        domains,
      },
    };
  }

  // Other ISM types (multisig, testIsm) have identical config structure
  // between Config API and Artifact API - just wrap in artifact object
  return { artifactState: ArtifactState.NEW, config };
}
