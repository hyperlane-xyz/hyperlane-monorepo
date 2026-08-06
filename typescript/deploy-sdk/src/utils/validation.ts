/**
 * Validation utilities for Alt-VM ISM configurations.
 *
 * The provider-sdk has a limited subset of ISM types compared to the full SDK.
 * These utilities validate ISM configs and provide clear error messages for unsupported types.
 */
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { IsmConfig, IsmType } from '@hyperlane-xyz/provider-sdk/ism';

/**
 * ISM types supported by provider-sdk for Alt-VM chains.
 * These correspond to the types defined in provider-sdk/src/ism.ts
 *
 * Typed as `ReadonlySet<string>` rather than `ReadonlySet<IsmType>`
 * deliberately: `validateIsmType`'s `ismType` parameter is arbitrary,
 * not-yet-validated input (a raw config field, possibly from an untrusted
 * registry entry), so `.has()` is called with a plain `string`. Narrowing
 * the set to `ReadonlySet<IsmType>` would just push an unsafe cast to
 * every call site instead of removing it.
 */
const SUPPORTED_ISM_TYPES: ReadonlySet<string> = new Set<IsmType>([
  'domainRoutingIsm',
  'merkleRootMultisigIsm',
  'messageIdMultisigIsm',
  'testIsm',
  'compositeIsm',
]);

/** ISM types restricted to a single Alt-VM protocol (Sealevel program, no cross-VM equivalent). */
const PROTOCOL_SPECIFIC_ISM_TYPES: Readonly<
  Partial<Record<string, ProtocolType>>
> = {
  compositeIsm: ProtocolType.Sealevel,
};

/**
 * Validates that an ISM type is supported by provider-sdk for the given protocol.
 *
 * @param ismType - The ISM type string to validate
 * @param chain - Chain name for error messages
 * @param context - Context string for error messages (e.g., "warp route", "core")
 * @param protocol - Protocol of the chain being validated. `protocol` is
 * optional only so pre-existing callers (validating one of the
 * always-cross-protocol types below) keep compiling — it does NOT loosen
 * validation for a protocol-gated type like compositeIsm. At the point
 * compositeIsm was introduced it was never accepted without a matching
 * protocol, so omitting `protocol` for it still fails, just with a
 * clearer "protocol required" reason instead of a generic type mismatch.
 * @throws UnsupportedIsmTypeError if ISM type is not supported
 */
export function validateIsmType(
  ismType: string,
  chain: string,
  context: string = 'configuration',
  protocol?: ProtocolType,
): void {
  const requiredProtocol = PROTOCOL_SPECIFIC_ISM_TYPES[ismType];
  const supported =
    SUPPORTED_ISM_TYPES.has(ismType) &&
    (requiredProtocol === undefined || requiredProtocol === protocol);

  if (!supported) {
    const supportedTypes = Array.from(SUPPORTED_ISM_TYPES)
      .filter((type) => {
        const required = PROTOCOL_SPECIFIC_ISM_TYPES[type];
        return required === undefined || required === protocol;
      })
      .join(', ');

    if (
      SUPPORTED_ISM_TYPES.has(ismType) &&
      requiredProtocol !== undefined &&
      protocol === undefined
    ) {
      throw new UnsupportedIsmTypeError(
        ismType,
        chain,
        context,
        `${supportedTypes} (ismType '${ismType}' requires the chain's protocol to be passed explicitly to validateIsmType/validateIsmConfig)`,
      );
    }
    throw new UnsupportedIsmTypeError(ismType, chain, context, supportedTypes);
  }
}

/**
 * Validates that an ISM configuration is supported by provider-sdk for the given protocol.
 *
 * @param config - ISM configuration (can be string address or config object)
 * @param chain - Chain name for error messages
 * @param context - Context string for error messages (e.g., "warp route", "core")
 * @param protocol - Protocol of the chain being validated. See validateIsmType.
 * @throws UnsupportedIsmTypeError if ISM type is not supported
 */
export function validateIsmConfig(
  config: IsmConfig | string,
  chain: string,
  context: string = 'configuration',
  protocol?: ProtocolType,
): void {
  // If it's a string address, it's valid (pre-deployed ISM)
  if (typeof config === 'string') {
    return;
  }

  // Validate the ISM type
  validateIsmType(config.type, chain, context, protocol);

  // Recursively validate nested ISMs in routing configs
  if (config.type === 'domainRoutingIsm') {
    for (const [domain, domainConfig] of Object.entries(config.domains)) {
      validateIsmConfig(
        domainConfig,
        chain,
        `${context} (domain routing for ${domain})`,
        protocol,
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
