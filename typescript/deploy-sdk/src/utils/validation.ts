/** Validation utilities for Alt-VM ISM configurations. */
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { IsmConfig, IsmType } from '@hyperlane-xyz/provider-sdk/ism';

/**
 * ISM types currently deployable through the Alt-VM interface.
 * The provider-sdk vocabulary is intentionally broader than this capability set.
 */
const SUPPORTED_ISM_TYPES: ReadonlySet<string> = new Set<IsmType>([
  IsmType.ROUTING,
  IsmType.MERKLE_ROOT_MULTISIG,
  IsmType.MESSAGE_ID_MULTISIG,
  IsmType.TEST_ISM,
  IsmType.COMPOSITE,
]);

const PROTOCOL_SPECIFIC_ISM_TYPES: Readonly<
  Partial<Record<string, ProtocolType>>
> = {
  [IsmType.COMPOSITE]: ProtocolType.Sealevel,
};

/**
 * Validates that an ISM type is supported for the given protocol.
 *
 * @param ismType - The ISM type string to validate
 * @param chain - Chain name for error messages
 * @param context - Context string for error messages (e.g., "warp route", "core")
 * @param protocol - Protocol of the chain being validated
 * @throws UnsupportedIsmTypeError if the ISM type is unsupported
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

  if (supported) return;

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

/**
 * Recursively validates that an ISM configuration is supported for the protocol.
 *
 * @param config - ISM configuration (can be string address or config object)
 * @param chain - Chain name for error messages
 * @param context - Context string for error messages (e.g., "warp route", "core")
 * @param protocol - Protocol of the chain being validated
 * @throws UnsupportedIsmTypeError if an ISM type is unsupported
 */
export function validateIsmConfig(
  config: IsmConfig | string,
  chain: string,
  context: string = 'configuration',
  protocol?: ProtocolType,
): void {
  if (typeof config === 'string') {
    return;
  }

  validateIsmType(config.type, chain, context, protocol);

  if (config.type === IsmType.ROUTING) {
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
