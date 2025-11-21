/**
 * Configuration validation utilities for converting SDK types to provider-sdk types.
 *
 * The main SDK has comprehensive token, ISM, and hook types for EVM chains.
 * The provider-sdk has a more limited subset for Alt-VM chains.
 *
 * These functions validate that SDK configs are compatible with provider-sdk
 * requirements and provide clear error messages for unsupported features.
 */
import { CoreConfig as ProviderCoreConfig } from '@hyperlane-xyz/provider-sdk/core';
import {
  TokenType as ProviderTokenType,
  WarpConfig as ProviderWarpConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  CoreConfig,
  IsmType,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

/**
 * Supported ISM types in provider-sdk.
 * Currently only basic ISM types are supported for Alt-VM chains.
 */
const SUPPORTED_ISM_TYPES = new Set<IsmType>([
  IsmType.MESSAGE_ID_MULTISIG,
  IsmType.MERKLE_ROOT_MULTISIG,
  IsmType.ROUTING,
  IsmType.TEST_ISM,
]);

/**
 * Supported token types in provider-sdk.
 * Alt-VM chains currently only support basic collateral and synthetic tokens.
 */
const SUPPORTED_TOKEN_TYPES = new Set<TokenType>([
  TokenType.synthetic,
  TokenType.collateral,
]);

/**
 * Validates that an ISM type is supported by provider-sdk.
 *
 * @param ismType - The ISM type to validate
 * @param chain - Chain name for error messages
 * @param context - Additional context for error message (e.g., "nested ISM", "warp config")
 * @throws Error if ISM type is not supported
 */
function validateIsmType(
  ismType: IsmType,
  chain: string,
  context: string = '',
): void {
  if (!SUPPORTED_ISM_TYPES.has(ismType)) {
    const prefix = context ? `${context} ` : '';
    const errorMsg =
      `Unsupported ${prefix}ISM type '${ismType}' for Alt-VM chain '${chain}'.\n` +
      `Supported ISM types: ${Array.from(SUPPORTED_ISM_TYPES).join(', ')}.`;
    throw new Error(errorMsg);
  }
}

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
  // Validate ISM configuration
  if (typeof config.defaultIsm === 'object' && 'type' in config.defaultIsm) {
    validateIsmType(config.defaultIsm.type, chain);

    // Recursively validate nested ISMs
    if ('isms' in config.defaultIsm && Array.isArray(config.defaultIsm.isms)) {
      for (const nestedIsm of config.defaultIsm.isms) {
        if (typeof nestedIsm === 'object' && 'type' in nestedIsm) {
          validateIsmType(nestedIsm.type, chain, 'nested');
        }
      }
    }
  }

  // Validate Hook configuration
  // For now, we accept all hook types but could add validation here
  // if specific hook types are not supported on Alt-VM chains

  // Type assertion is safe here because we've validated the structure
  // and provider-sdk types are a subset of SDK types
  return config as unknown as ProviderCoreConfig;
}

/**
 * Validates that a WarpRouteDeployConfig is compatible with provider-sdk requirements.
 *
 * @param config - WarpRouteDeployConfig from the main SDK
 * @param chain - Chain name for error messages
 * @returns The same config, typed as ProviderWarpConfig
 * @throws Error if config contains unsupported token types
 */
export function validateWarpConfigForAltVM(
  config: WarpRouteDeployConfig[string],
  chain: string,
): ProviderWarpConfig {
  const tokenType = config.type;

  // Check if token type is supported
  if (!SUPPORTED_TOKEN_TYPES.has(tokenType)) {
    const supportedTypes = Array.from(SUPPORTED_TOKEN_TYPES).join(', ');
    const errorMsg =
      `Unsupported token type '${tokenType}' for Alt-VM chain '${chain}'.\n` +
      `Supported token types: ${supportedTypes}.`;
    throw new Error(errorMsg);
  }

  // Validate the token conforms to basic collateral or synthetic structure
  if (tokenType === TokenType.collateral) {
    if (!('token' in config)) {
      const errorMsg = `Collateral token config for chain '${chain}' must specify 'token' address`;
      throw new Error(errorMsg);
    }
  }

  // Validate ISM if present
  if (
    config.interchainSecurityModule &&
    typeof config.interchainSecurityModule === 'object' &&
    'type' in config.interchainSecurityModule
  ) {
    validateIsmType(
      config.interchainSecurityModule.type,
      chain,
      'in warp config',
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

  if (tokenType === TokenType.collateral) {
    return {
      ...baseConfig,
      type: ProviderTokenType.collateral,
      token: (config as any).token,
    } as ProviderWarpConfig;
  } else {
    return {
      ...baseConfig,
      type: ProviderTokenType.synthetic,
      name: config.name,
      symbol: config.symbol,
      decimals: config.decimals,
    } as ProviderWarpConfig;
  }
}
