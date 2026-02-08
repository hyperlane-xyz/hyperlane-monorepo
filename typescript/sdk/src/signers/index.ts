// Signer configuration types and schemas
export {
  SignerType,
  SignerConfigSchema,
  SignerConfig,
  RawKeySignerConfigSchema,
  RawKeySignerConfig,
  TurnkeySignerConfigSchema,
  TurnkeySignerConfig,
  GCPSecretSignerConfigSchema,
  GCPSecretSignerConfig,
  FoundryKeystoreSignerConfigSchema,
  FoundryKeystoreSignerConfig,
  SignerRefSchema,
  SignerRef,
  SignerOrRefSchema,
  SignerOrRef,
  isSignerRef,
  SignerConfigMap,
  SignerDefaultsSchema,
  SignerDefaults,
  SignerConfigurationSchema,
  SignerConfiguration,
} from './config.js';

// Signer factory
export {
  SignerFactory,
  ExtractedKey,
  EXTRACTABLE_SIGNER_TYPES,
} from './SignerFactory.js';

// Existing signer exports
export { getSignerForChain } from './signers.js';
export type { MultiProtocolSignerSignerAccountInfo } from './signers.js';

// Types
export type { IMultiProtocolSigner } from './types.js';

// Turnkey
export { TurnkeyClientManager, TurnkeyConfig } from './turnkeyClient.js';
export { TurnkeyEvmSigner } from './evm/turnkey.js';
