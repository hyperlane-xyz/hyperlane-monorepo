/**
 * Validation utilities for Alt-VM ISM configurations.
 *
 * The provider-sdk has a limited subset of ISM types compared to the full SDK.
 * These utilities validate ISM configs and provide clear error messages for unsupported types.
 */
import { IsmConfig, IsmType } from '@hyperlane-xyz/provider-sdk/ism';

/**
 * ISM types supported by provider-sdk for Alt-VM chains.
 * These correspond to the types defined in provider-sdk/src/ism.ts
 */
const SUPPORTED_ISM_TYPES: Set<IsmType> = new Set([
  'domainRoutingIsm',
  'merkleRootMultisigIsm',
  'messageIdMultisigIsm',
  'testIsm',
]);

/**
 * Validates that an ISM configuration is supported by provider-sdk.
 *
 * @param config - ISM configuration (can be string address or config object)
 * @param chain - Chain name for error messages
 * @param context - Context string for error messages (e.g., "warp route", "core")
 * @throws Error if ISM type is not supported
 */
export function validateIsmConfig(
  config: IsmConfig | string,
  chain: string,
  context: string = 'configuration',
): void {
  // If it's a string address, it's valid (pre-deployed ISM)
  if (typeof config === 'string') {
    return;
  }

  // Validate the ISM type
  const ismType = config.type;
  if (!SUPPORTED_ISM_TYPES.has(ismType)) {
    const supportedTypes = Array.from(SUPPORTED_ISM_TYPES).join(', ');
    throw new UnsupportedIsmTypeError(ismType, chain, context, supportedTypes);
  }

  // Recursively validate nested ISMs in routing configs
  if (ismType === 'domainRoutingIsm') {
    for (const [domain, domainConfig] of Object.entries(config.domains)) {
      validateIsmConfig(
        domainConfig,
        chain,
        `${context} (domain routing for ${domain})`,
      );
    }
  }
}

/**
 * Custom error class for unsupported ISM types.
 * Provides concise error messages.
 */
export class UnsupportedIsmTypeError extends Error {
  constructor(
    public readonly ismType: string,
    public readonly chain: string,
    public readonly context: string,
    public readonly supportedTypes: string,
  ) {
    super(
      `Unsupported ISM type '${ismType}' for Alt-VM chain '${chain}' in ${context}. ` +
        `Supported types: ${supportedTypes}`,
    );
    this.name = 'UnsupportedIsmTypeError';
  }
}
