import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import type { TActivity } from '@turnkey/sdk-server';
import { TurnkeyServerClient } from '@turnkey/sdk-server';

import { deepCopy, rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'sdk:turnkey-client' });

/**
 * Extract safe error message from error object
 * Avoids logging sensitive data like API keys, stack traces, etc.
 * Handles TurnkeyActivityError, TurnkeyRequestError, and standard Error types
 */
function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

/**
 * Log Turnkey operation error safely without exposing sensitive data
 * Accepts unknown errors from catch blocks and safely extracts error messages
 */
export function logTurnkeyError(operation: string, error: unknown): void {
  const errorMessage = getSafeErrorMessage(error);
  logger.error(`${operation}:`, errorMessage);
}

/**
 * Validate that a Turnkey activity completed successfully
 * The Turnkey SDK polls internally until the activity completes or max retries are reached.
 * If we receive a non-completed status, it indicates an SDK bug or request error.
 */
export function validateTurnkeyActivityCompleted(
  activity: TActivity,
  operationType: string,
): void {
  if (activity.status !== 'ACTIVITY_STATUS_COMPLETED') {
    throw new Error(
      `${operationType} activity did not complete. Status: ${activity.status}`,
    );
  }
}

/**
 * Default Turnkey API base URL
 */
export const DEFAULT_TURNKEY_API_BASE_URL = 'https://api.turnkey.com';

/**
 * Unified Turnkey configuration for both Sealevel and EVM keys
 * The publicKey field contains:
 * - For Sealevel: base58-encoded Solana public key
 * - For EVM: hex-encoded Ethereum address
 */
export type TurnkeyConfig = {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  privateKeyId: string;
  publicKey: string;
  apiBaseUrl?: string; // Optional API base URL (defaults to DEFAULT_TURNKEY_API_BASE_URL)
};

/**
 * Shared Turnkey client manager
 * Handles initialization, health checks, and provides access to the Turnkey client
 *
 * This class is used by all VM-specific signers via composition rather than inheritance,
 * allowing each signer to extend/implement their VM-specific base classes while
 * still sharing common Turnkey functionality.
 *
 * @example
 * ```typescript
 * const manager = new TurnkeyClientManager(config);
 * await manager.healthCheck();
 * const client = manager.getClient();
 * ```
 */
export class TurnkeyClientManager {
  private readonly client: TurnkeyServerClient;
  private readonly config: TurnkeyConfig;

  constructor(config: TurnkeyConfig) {
    this.config = config;

    const stamper = new ApiKeyStamper({
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
    });

    this.client = new TurnkeyServerClient({
      organizationId: config.organizationId,
      stamper,
      apiBaseUrl: config.apiBaseUrl || DEFAULT_TURNKEY_API_BASE_URL,
    });
  }

  /**
   * Get a copy of the configuration (for creating new signer instances)
   */
  getConfig(): TurnkeyConfig {
    return deepCopy(this.config);
  }

  /**
   * Get the Turnkey client (for signing operations)
   */
  getClient(): TurnkeyServerClient {
    return this.client;
  }

  /**
   * Get organization ID
   */
  getOrganizationId(): string {
    return this.config.organizationId;
  }

  /**
   * Check if Turnkey is properly configured and accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      logger.debug('Running Turnkey health check...');

      const whoami = await this.client.getWhoami({
        organizationId: this.config.organizationId,
      });

      logger.debug(
        `Turnkey health check passed. Organization ID: ${whoami.organizationId}`,
      );
      return true;
    } catch (error) {
      logTurnkeyError('Turnkey health check failed', error);
      return false;
    }
  }
}
