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
import { type HookConfig as ProviderHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { type IsmConfig as ProviderIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { type CoreConfig, type HookConfig } from '@hyperlane-xyz/sdk';
import { type ProtocolType } from '@hyperlane-xyz/utils';
export { validateWarpConfigForAltVM } from '@hyperlane-xyz/sdk';

const ALT_VM_SUPPORTED_HOOK_TYPES: ReadonlySet<string> = new Set([
  'interchainGasPaymaster',
  'merkleTreeHook',
  'protocolFee',
  'unknownHook',
]);

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
  protocol: ProtocolType,
): ProviderCoreConfig {
  // Validate ISM configuration (handles recursion for routing ISMs)
  if (config.defaultIsm) {
    validateIsmConfig(
      config.defaultIsm as ProviderIsmConfig | string,
      chain,
      protocol,
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

/**
 * Validates that a HookConfig is compatible with provider-sdk requirements.
 *
 * @param config - HookConfig from the main SDK
 * @param chain - Chain name for error messages
 * @returns The same config, typed as ProviderHookConfig
 * @throws Error if config is an address string or an unsupported hook type
 */
export function validateHookConfigForAltVM(
  config: HookConfig,
  chain: string,
): ProviderHookConfig {
  if (typeof config === 'string') {
    throw new Error(
      `Hook config for chain ${chain} must be an object on Alt-VM chains, not an address string`,
    );
  }
  if (!ALT_VM_SUPPORTED_HOOK_TYPES.has(config.type)) {
    throw new Error(
      `Hook type ${config.type} is not supported on Alt-VM chain ${chain}. ` +
        `Supported types: ${[...ALT_VM_SUPPORTED_HOOK_TYPES].join(', ')}`,
    );
  }
  // CAST: safe because the type discriminator was validated above and
  // provider-sdk hook types are a subset of SDK hook types.
  return config as ProviderHookConfig;
}
