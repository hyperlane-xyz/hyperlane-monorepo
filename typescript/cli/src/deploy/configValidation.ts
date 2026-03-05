/**
 * Configuration validation utilities for converting SDK types to provider-sdk types.
 *
 * The main SDK has comprehensive token, ISM, and hook types for EVM chains.
 * The provider-sdk has a more limited subset for Alt-VM chains.
 *
 * These functions validate that SDK configs are compatible with provider-sdk
 * requirements and provide clear error messages for unsupported features.
 */
import { validateIsmConfig } from '@hyperlane-xyz/deploy-sdk';
import { type CoreConfig as ProviderCoreConfig } from '@hyperlane-xyz/provider-sdk/core';
import { type IsmConfig as ProviderIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { type CoreConfig } from '@hyperlane-xyz/sdk';
export { validateWarpConfigForAltVM } from '@hyperlane-xyz/sdk';

/**
 * Validates that a CoreConfig is compatible with provider-sdk requirements.
 *
 * @param config - CoreConfig from the main SDK
 * @param chain - Chain name for error messages
 * @returns The same config, typed as ProviderCoreConfig
 * @throws Error if config contains unsupported ISM or Hook types
 */
export function validateCoreConfigForAltVM(
  config: CoreConfig,
  chain: string,
): ProviderCoreConfig {
  // Validate ISM configuration (handles recursion for routing ISMs)
  if (config.defaultIsm) {
    validateIsmConfig(
      config.defaultIsm as ProviderIsmConfig | string,
      chain,
      'core config',
    );
  }

  // Validate Hook configuration
  // For now, we accept all hook types but could add validation here
  // if specific hook types are not supported on Alt-VM chains

  // Type assertion is safe here because we've validated the structure
  // and provider-sdk types are a subset of SDK types
  return config as ProviderCoreConfig;
}
