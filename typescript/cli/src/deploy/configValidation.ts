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
import { CoreConfig as ProviderCoreConfig } from '@hyperlane-xyz/provider-sdk/core';
import { IsmConfig as ProviderIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import {
  CollateralWarpConfig,
  NativeWarpConfig,
  TokenType as ProviderTokenType,
  WarpConfig as ProviderWarpConfig,
  SyntheticWarpConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  CoreConfig,
  TokenType,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';

/**
 * Supported token types in provider-sdk.
 * Alt-VM chains currently support collateral, synthetic, and native tokens.
 */
const SUPPORTED_TOKEN_TYPES = new Set<TokenType>([
  TokenType.synthetic,
  TokenType.collateral,
  TokenType.native,
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

/**
 * Validates that a WarpRouteDeployConfig is compatible with provider-sdk requirements.
 *
 * @param config - WarpRouteDeployConfig from the main SDK
 * @param chain - Chain name for error messages
 * @returns a provider-sdk WarpConfig derived from the given config
 * @throws Error if config contains unsupported token types
 */
export function validateWarpConfigForAltVM(
  config: WarpRouteDeployConfigMailboxRequired[string],
  chain: string,
): ProviderWarpConfig {
  // Check if token type is supported
  if (!SUPPORTED_TOKEN_TYPES.has(config.type)) {
    const supportedTypes = Array.from(SUPPORTED_TOKEN_TYPES).join(', ');
    const errorMsg =
      `Unsupported token type '${config.type}' for Alt-VM chain '${chain}'.\n` +
      `Supported token types: ${supportedTypes}.`;
    throw new Error(errorMsg);
  }

  // Validate the token conforms to basic collateral or synthetic structure
  if (config.type === TokenType.collateral) {
    if (!config.token) {
      const errorMsg = `Collateral token config for chain '${chain}' must specify 'token' address`;
      throw new Error(errorMsg);
    }
  }

  // Validate ISM if present (handles recursion for routing ISMs)
  if (config.interchainSecurityModule) {
    validateIsmConfig(
      config.interchainSecurityModule as ProviderIsmConfig | string,
      chain,
      'warp config',
    );
  }

  // Construct the provider-sdk config
  const baseConfig = {
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule: config.interchainSecurityModule,
    hook: config.hook,
    remoteRouters: config.remoteRouters,
    destinationGas: config.destinationGas,
  };

  if (config.type === TokenType.collateral) {
    return {
      ...baseConfig,
      type: ProviderTokenType.collateral,
      token: config.token,
    } as CollateralWarpConfig;
  } else if (config.type === TokenType.synthetic) {
    return {
      ...baseConfig,
      type: ProviderTokenType.synthetic,
      name: config.name,
      symbol: config.symbol,
      decimals: config.decimals,
    } as SyntheticWarpConfig;
  } else if (config.type === TokenType.native) {
    return {
      ...baseConfig,
      type: ProviderTokenType.native,
    } as NativeWarpConfig;
  } else {
    throw new Error(
      `Unsupported token type '${config.type}' for Alt-VM chain '${chain}'.`,
    );
  }
}
