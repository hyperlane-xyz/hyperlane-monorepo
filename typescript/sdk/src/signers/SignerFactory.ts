import { Signer, Wallet } from 'ethers';
import type { providers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  FoundryKeystoreSignerConfig,
  GCPSecretSignerConfig,
  RawKeySignerConfig,
  SignerConfig,
  SignerType,
  TurnkeySignerConfig,
} from './config.js';
import { TurnkeyEvmSigner } from './evm/turnkey.js';

const logger = rootLogger.child({ module: 'signer-factory' });

/**
 * Result of extracting a private key from a signer configuration
 */
export interface ExtractedKey {
  /** The hex-encoded private key (with 0x prefix) */
  privateKey: string;
  /** The derived address */
  address: string;
}

/**
 * Signer types that support private key extraction
 */
export const EXTRACTABLE_SIGNER_TYPES = [
  SignerType.RAW_KEY,
  SignerType.GCP_SECRET,
] as const;

/**
 * Factory for creating ethers Signers from SignerConfig objects
 */
export class SignerFactory {
  /**
   * Create an ethers Signer from a SignerConfig
   *
   * @param config - The signer configuration
   * @param provider - Optional provider to connect the signer to
   * @returns A configured ethers Signer
   */
  static async createSigner(
    config: SignerConfig,
    provider?: providers.Provider,
  ): Promise<Signer> {
    switch (config.type) {
      case SignerType.RAW_KEY:
        return SignerFactory.createRawKeySigner(config, provider);
      case SignerType.TURNKEY:
        return SignerFactory.createTurnkeySigner(config, provider);
      case SignerType.GCP_SECRET:
        return SignerFactory.createGCPSecretSigner(config, provider);
      case SignerType.FOUNDRY_KEYSTORE:
        return SignerFactory.createFoundryKeystoreSigner(config, provider);
      default:
        throw new Error(
          `Unknown signer type: ${(config as SignerConfig).type}`,
        );
    }
  }

  /**
   * Check if a signer type supports private key extraction
   */
  static isExtractable(config: SignerConfig): boolean {
    return (EXTRACTABLE_SIGNER_TYPES as readonly SignerType[]).includes(
      config.type,
    );
  }

  /**
   * Extract the private key from a signer configuration.
   *
   * Only supported for signer types that have extractable keys:
   * - RAW_KEY: Returns the key directly or from env var
   * - GCP_SECRET: Fetches and returns the key from GCP Secret Manager
   *
   * Not supported for:
   * - TURNKEY: Keys are managed in secure enclaves and cannot be extracted
   * - FOUNDRY_KEYSTORE: Use `cast wallet decrypt-keystore` instead
   *
   * @param config - The signer configuration
   * @returns The extracted private key and derived address
   * @throws Error if the signer type doesn't support key extraction
   */
  static async extractPrivateKey(config: SignerConfig): Promise<ExtractedKey> {
    switch (config.type) {
      case SignerType.RAW_KEY:
        return SignerFactory.extractRawKey(config);
      case SignerType.GCP_SECRET:
        return SignerFactory.extractGCPSecretKey(config);
      case SignerType.TURNKEY:
        throw new Error(
          'Turnkey signers do not support key extraction. ' +
            'Keys are managed in secure enclaves and cannot be exported.',
        );
      case SignerType.FOUNDRY_KEYSTORE:
        throw new Error(
          'Foundry keystore signers do not support key extraction via this command. ' +
            'Use `cast wallet decrypt-keystore <account>` instead.',
        );
      default:
        throw new Error(
          `Unknown signer type: ${(config as SignerConfig).type}`,
        );
    }
  }

  /**
   * Extract private key from a raw key config
   */
  private static extractRawKey(config: RawKeySignerConfig): ExtractedKey {
    let privateKey: string | undefined;

    if (config.privateKey) {
      privateKey = config.privateKey;
    } else if (config.privateKeyEnvVar) {
      privateKey = process.env[config.privateKeyEnvVar];
      if (!privateKey) {
        throw new Error(
          `Environment variable ${config.privateKeyEnvVar} is not set`,
        );
      }
    }

    if (!privateKey) {
      throw new Error(
        'RawKey signer requires either privateKey or privateKeyEnvVar',
      );
    }

    const wallet = new Wallet(privateKey);
    return {
      privateKey: wallet.privateKey,
      address: wallet.address,
    };
  }

  /**
   * Extract private key from a GCP Secret Manager config
   */
  private static async extractGCPSecretKey(
    config: GCPSecretSignerConfig,
  ): Promise<ExtractedKey> {
    const privateKey = await SignerFactory.fetchGCPSecret(
      config.project,
      config.secretName,
    );

    const wallet = new Wallet(privateKey);
    return {
      privateKey: wallet.privateKey,
      address: wallet.address,
    };
  }

  /**
   * Create a signer from a raw private key or environment variable
   */
  private static createRawKeySigner(
    config: RawKeySignerConfig,
    provider?: providers.Provider,
  ): Signer {
    let privateKey: string | undefined;

    if (config.privateKey) {
      privateKey = config.privateKey;
    } else if (config.privateKeyEnvVar) {
      privateKey = process.env[config.privateKeyEnvVar];
      if (!privateKey) {
        throw new Error(
          `Environment variable ${config.privateKeyEnvVar} is not set`,
        );
      }
    }

    if (!privateKey) {
      throw new Error(
        'RawKey signer requires either privateKey or privateKeyEnvVar',
      );
    }

    logger.debug('Creating raw key signer');
    const wallet = new Wallet(privateKey);
    return provider ? wallet.connect(provider) : wallet;
  }

  /**
   * Create a Turnkey-managed signer
   */
  private static createTurnkeySigner(
    config: TurnkeySignerConfig,
    provider?: providers.Provider,
  ): Signer {
    logger.debug('Creating Turnkey signer');
    return new TurnkeyEvmSigner(
      {
        organizationId: config.organizationId,
        apiPublicKey: config.apiPublicKey,
        apiPrivateKey: config.apiPrivateKey,
        privateKeyId: config.privateKeyId,
        publicKey: config.publicKey,
        apiBaseUrl: config.apiBaseUrl,
      },
      provider,
    );
  }

  /**
   * Create a signer by fetching a private key from GCP Secret Manager
   */
  private static async createGCPSecretSigner(
    config: GCPSecretSignerConfig,
    provider?: providers.Provider,
  ): Promise<Signer> {
    logger.debug(
      `Fetching private key from GCP Secret Manager: ${config.project}/${config.secretName}`,
    );

    const privateKey = await SignerFactory.fetchGCPSecret(
      config.project,
      config.secretName,
    );

    const wallet = new Wallet(privateKey);
    return provider ? wallet.connect(provider) : wallet;
  }

  /**
   * Create a signer from a Foundry keystore file
   *
   * Password resolution order:
   * 1. config.passwordFile - direct path to password file
   * 2. config.passwordEnvVar - env var containing the password directly
   * 3. ETH_PASSWORD env var - Foundry standard, path to password file
   */
  private static async createFoundryKeystoreSigner(
    config: FoundryKeystoreSignerConfig,
    provider?: providers.Provider,
  ): Promise<Signer> {
    const keystorePath =
      config.keystorePath || path.join(os.homedir(), '.foundry', 'keystores');
    const keystoreFile = path.join(keystorePath, config.accountName);

    logger.debug(`Loading keystore from: ${keystoreFile}`);

    if (!fs.existsSync(keystoreFile)) {
      throw new Error(`Keystore file not found: ${keystoreFile}`);
    }

    const keystoreJson = fs.readFileSync(keystoreFile, 'utf-8');
    const password = SignerFactory.resolveKeystorePassword(config);

    const wallet = await Wallet.fromEncryptedJson(keystoreJson, password);
    return provider ? wallet.connect(provider) : wallet;
  }

  /**
   * Resolve the keystore password using Foundry-compatible conventions.
   *
   * Resolution order:
   * 1. config.passwordFile - direct path to password file
   * 2. config.passwordEnvVar - env var containing the password directly
   * 3. ETH_PASSWORD env var - Foundry standard, path to password file
   */
  private static resolveKeystorePassword(
    config: FoundryKeystoreSignerConfig,
  ): string {
    // 1. Direct password file path in config
    if (config.passwordFile) {
      if (!fs.existsSync(config.passwordFile)) {
        throw new Error(`Password file not found: ${config.passwordFile}`);
      }
      return fs.readFileSync(config.passwordFile, 'utf-8').trim();
    }

    // 2. Environment variable containing password directly
    if (config.passwordEnvVar) {
      const password = process.env[config.passwordEnvVar];
      if (!password) {
        throw new Error(
          `Environment variable ${config.passwordEnvVar} is not set`,
        );
      }
      return password;
    }

    // 3. Foundry standard: ETH_PASSWORD env var points to password file
    const ethPasswordPath = process.env.ETH_PASSWORD;
    if (ethPasswordPath) {
      if (!fs.existsSync(ethPasswordPath)) {
        throw new Error(
          `Password file from ETH_PASSWORD not found: ${ethPasswordPath}`,
        );
      }
      return fs.readFileSync(ethPasswordPath, 'utf-8').trim();
    }

    throw new Error(
      `Keystore password not provided. Options:\n` +
        `  1. Set passwordFile in signer config\n` +
        `  2. Set passwordEnvVar in signer config\n` +
        `  3. Set ETH_PASSWORD env var to path of password file (Foundry standard)`,
    );
  }

  /**
   * Fetch a secret from GCP Secret Manager using the gcloud CLI.
   * This avoids requiring the @google-cloud/secret-manager package as a dependency.
   */
  private static async fetchGCPSecret(
    project: string,
    secretName: string,
  ): Promise<string> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const command = `gcloud secrets versions access latest --secret="${secretName}" --project="${project}"`;
    logger.debug(`Fetching secret from GCP: ${project}/${secretName}`);

    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      if (stderr) {
        logger.warn(`gcloud stderr: ${stderr}`);
      }

      const secret = stdout.trim();
      if (!secret) {
        throw new Error(`Secret ${secretName} is empty`);
      }

      return secret;
    } catch (error: any) {
      const errorMessage = error.stderr || error.message || String(error);

      // Check for common gcloud errors and provide helpful messages
      if (errorMessage.includes('command not found')) {
        throw new Error(
          'gcloud CLI not found. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install',
        );
      }
      if (
        errorMessage.includes('PERMISSION_DENIED') ||
        errorMessage.includes('does not have permission')
      ) {
        throw new Error(
          `Permission denied accessing secret ${project}/${secretName}. ` +
            `Ensure you have roles/secretmanager.secretAccessor permission.`,
        );
      }
      if (errorMessage.includes('NOT_FOUND')) {
        throw new Error(
          `Secret not found: ${project}/${secretName}. ` +
            `Verify the project ID and secret name are correct.`,
        );
      }
      if (errorMessage.includes('Could not load the default credentials')) {
        throw new Error(
          'GCP authentication required. Run: gcloud auth application-default login',
        );
      }

      throw new Error(`Failed to fetch GCP secret: ${errorMessage}`);
    }
  }
}
