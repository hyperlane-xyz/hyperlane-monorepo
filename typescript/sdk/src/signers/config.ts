import { z } from 'zod';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ZChainName, ZHash } from '../metadata/customZodTypes.js';

/**
 * Signer types supported by the signer abstraction
 */
export enum SignerType {
  /** Raw private key (hex string or env var reference) */
  RAW_KEY = 'rawKey',
  /** Turnkey-managed signing */
  TURNKEY = 'turnkey',
  /** Private key stored in GCP Secret Manager */
  GCP_SECRET = 'gcpSecret',
  /** Foundry keystore file */
  FOUNDRY_KEYSTORE = 'foundryKeystore',
}

/**
 * Raw key signer configuration
 * Supports direct private key or environment variable reference
 */
export const RawKeySignerConfigSchema = z.object({
  type: z.literal(SignerType.RAW_KEY),
  /** Direct private key (hex string with 0x prefix) */
  privateKey: ZHash.optional(),
  /** Environment variable name containing the private key */
  privateKeyEnvVar: z.string().optional(),
});

export type RawKeySignerConfig = z.infer<typeof RawKeySignerConfigSchema>;

/**
 * Turnkey signer configuration
 * Uses Turnkey's secure enclaves for signing
 */
export const TurnkeySignerConfigSchema = z.object({
  type: z.literal(SignerType.TURNKEY),
  organizationId: z.string(),
  apiPublicKey: z.string(),
  apiPrivateKey: z.string(),
  privateKeyId: z.string(),
  /** The public key / address for the signing key */
  publicKey: z.string(),
  /** Optional API base URL (defaults to Turnkey's production API) */
  apiBaseUrl: z.string().optional(),
});

export type TurnkeySignerConfig = z.infer<typeof TurnkeySignerConfigSchema>;

/**
 * GCP Secret Manager signer configuration
 * Fetches a private key from GCP Secret Manager at runtime
 */
export const GCPSecretSignerConfigSchema = z.object({
  type: z.literal(SignerType.GCP_SECRET),
  /** GCP project ID */
  project: z.string(),
  /** Secret name in GCP Secret Manager */
  secretName: z.string(),
});

export type GCPSecretSignerConfig = z.infer<typeof GCPSecretSignerConfigSchema>;

/**
 * Foundry keystore signer configuration
 * Loads a key from a Foundry-compatible keystore file
 *
 * Password resolution (in order):
 * 1. passwordFile - direct path to password file
 * 2. passwordEnvVar - env var containing the password directly
 * 3. ETH_PASSWORD env var - Foundry standard, path to password file
 */
export const FoundryKeystoreSignerConfigSchema = z.object({
  type: z.literal(SignerType.FOUNDRY_KEYSTORE),
  /** Account name in the keystore */
  accountName: z.string(),
  /** Path to the keystore directory (defaults to ~/.foundry/keystores) */
  keystorePath: z.string().optional(),
  /** Path to a file containing the keystore password */
  passwordFile: z.string().optional(),
  /** Environment variable containing the keystore password directly (not recommended for production) */
  passwordEnvVar: z.string().optional(),
});

export type FoundryKeystoreSignerConfig = z.infer<
  typeof FoundryKeystoreSignerConfigSchema
>;

/**
 * Union of all signer configuration types
 */
export const SignerConfigSchema = z.discriminatedUnion('type', [
  RawKeySignerConfigSchema,
  TurnkeySignerConfigSchema,
  GCPSecretSignerConfigSchema,
  FoundryKeystoreSignerConfigSchema,
]);

export type SignerConfig = z.infer<typeof SignerConfigSchema>;

/**
 * Reference to a named signer defined elsewhere in the registry
 */
export const SignerRefSchema = z.object({
  ref: z.string(),
});

export type SignerRef = z.infer<typeof SignerRefSchema>;

/**
 * Either an inline signer config or a reference to a named signer
 */
export const SignerOrRefSchema = z.union([SignerConfigSchema, SignerRefSchema]);

export type SignerOrRef = z.infer<typeof SignerOrRefSchema>;

/**
 * Helper to check if a signer config is a reference
 */
export function isSignerRef(config: SignerOrRef): config is SignerRef {
  return 'ref' in config;
}

/**
 * Map of named signer configurations
 */
export type SignerConfigMap = Record<string, SignerConfig>;

/**
 * Hierarchical signer defaults
 * Resolution order: chain > protocol > default
 */
export const SignerDefaultsSchema = z.object({
  /** Default signer for all chains */
  default: SignerOrRefSchema.optional(),
  /** Per-protocol signer overrides */
  protocols: z
    .record(z.nativeEnum(ProtocolType), SignerOrRefSchema)
    .optional(),
  /** Per-chain signer overrides */
  chains: z.record(ZChainName, SignerOrRefSchema).optional(),
});

export type SignerDefaults = z.infer<typeof SignerDefaultsSchema>;

/**
 * Complete signer configuration for a registry
 * Contains named signers and hierarchical defaults
 */
export const SignerConfigurationSchema = z.object({
  /** Named signer configurations */
  signers: z.record(z.string(), SignerConfigSchema).optional(),
  /** Hierarchical defaults for signer resolution */
  defaults: SignerDefaultsSchema.optional(),
});

export type SignerConfiguration = z.infer<typeof SignerConfigurationSchema>;
