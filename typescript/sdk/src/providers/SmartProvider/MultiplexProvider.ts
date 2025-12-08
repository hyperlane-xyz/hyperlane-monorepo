/* eslint-disable no-console */
import { Logger } from '@ethersproject/logger';
import { Network, Networkish } from '@ethersproject/networks';
import { BaseProvider } from '@ethersproject/providers';
import { JsonRpcProvider } from '@ethersproject/providers';

const logger = new Logger('multiplex-provider/1.0.0');

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * MultiplexProvider with failover and exponential backoff retry logic.
 *
 * Strategy:
 * 1. Try each provider in sequence (failover)
 * 2. When all providers fail with recoverable errors, retry with exponential backoff
 * 3. Stop immediately on non-recoverable errors
 */
export class MultiplexProvider extends BaseProvider {
  readonly providers: JsonRpcProvider[];
  readonly retryConfig: RetryConfig;
  private _detectNetworkCallCount = 0;

  constructor(
    urls: string[],
    network?: Networkish,
    retryConfig?: Partial<RetryConfig>,
  ) {
    if (urls.length === 0) {
      throw new Error('At least one URL must be provided');
    }

    console.log(
      `[DEBUG] MultiplexProvider constructor - Creating with ${urls.length} URLs`,
    );
    console.log('[DEBUG] MultiplexProvider constructor - Network:', network);
    console.log(
      '[DEBUG] MultiplexProvider constructor - RetryConfig:',
      retryConfig,
    );

    // If network is known, pass it; otherwise use "any" for dynamic detection
    super(network || 'any');

    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

    this.providers = urls.map((url) => {
      // Create child providers but DON'T start their polling
      const provider = new JsonRpcProvider(url, network);
      provider.polling = false; // Disable - we'll handle polling at the multiplex level
      return provider;
    });
  }

  async detectNetwork(): Promise<Network> {
    // Increment call counter
    const callNum = ++this._detectNetworkCallCount;

    // Cache detection to avoid redundant work from multiple concurrent calls
    if (this._networkDetectionPromise) {
      console.log(
        `[DEBUG #${callNum}] MultiplexProvider.detectNetwork() - Using cached promise`,
      );
      return this._networkDetectionPromise;
    }

    console.log(
      `[DEBUG #${callNum}] MultiplexProvider.detectNetwork() - Starting NEW detection`,
    );

    // Store the promise so concurrent calls use the same detection
    this._networkDetectionPromise = this._performNetworkDetection();
    return this._networkDetectionPromise;
  }

  private _networkDetectionPromise?: Promise<Network>;

  private async _performNetworkDetection(): Promise<Network> {
    // Try each provider until one succeeds
    const errors: Error[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      console.log(
        `[DEBUG] MultiplexProvider._performNetworkDetection() - Trying provider ${i + 1}/${this.providers.length}`,
      );

      try {
        const network = await provider.detectNetwork();
        console.log(
          `[DEBUG] MultiplexProvider._performNetworkDetection() - Provider ${i + 1} detected network chainId=${network.chainId}, name=${network.name}`,
        );

        // Verify all providers are on the same network (in parallel, with timeouts)
        await this._verifyNetworkConsistency(network);

        console.log(
          '[DEBUG] MultiplexProvider._performNetworkDetection() - Network detection complete',
        );
        return network;
      } catch (error) {
        console.log(
          `[DEBUG] MultiplexProvider._performNetworkDetection() - Provider ${i + 1} failed:`,
          (error as Error).message,
        );
        errors.push(error as Error);
      }
    }

    throw new Error(
      `All providers failed to detect network: ${errors.map((e) => e.message).join(', ')}`,
    );
  }

  private async _verifyNetworkConsistency(
    expectedNetwork: Network,
  ): Promise<void> {
    console.log(
      `[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Verifying ${this.providers.length} providers for chainId=${expectedNetwork.chainId} (parallel with 3s timeout each)`,
    );

    // Verify all URLs are for the same network in parallel with timeouts
    const verificationPromises = this.providers.map(async (provider, i) => {
      console.log(
        `[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Starting check for provider ${i + 1}/${this.providers.length}`,
      );

      try {
        // Add 3 second timeout for each provider check
        const network = await Promise.race([
          provider.detectNetwork(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Verification timeout')), 3000),
          ),
        ]);

        if (network.chainId !== expectedNetwork.chainId) {
          console.log(
            `[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Provider ${i + 1} mismatch: expected ${expectedNetwork.chainId}, got ${network.chainId}`,
          );
          logger.warn(
            `Network mismatch: expected chainId ${expectedNetwork.chainId}, got ${network.chainId} from provider`,
          );
        } else {
          console.log(
            `[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Provider ${i + 1} OK (chainId=${network.chainId})`,
          );
        }
      } catch (error) {
        console.log(
          `[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Provider ${i + 1} failed:`,
          (error as Error).message,
        );
        // Log warning but don't fail - this provider might be temporarily down
        logger.warn(
          `Provider network verification failed: ${(error as Error).message}`,
        );
      }
    });

    // Wait for all verifications to complete (with timeouts)
    await Promise.all(verificationPromises);

    console.log(
      '[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Verification complete',
    );
  }

  async perform(method: string, params: any): Promise<any> {
    console.log(`[DEBUG] MultiplexProvider.perform() - RPC call: ${method}`);
    return this._performWithRetry(method, params);
  }

  /**
   * Determines if an error is recoverable and should trigger retry/failover.
   */
  private _isRecoverableError(error: any): boolean {
    const code = error.code;

    // Recoverable error codes
    const recoverableCodes = [
      Logger.errors.SERVER_ERROR,
      Logger.errors.TIMEOUT,
      Logger.errors.NETWORK_ERROR,
      Logger.errors.UNKNOWN_ERROR,
    ];

    if (recoverableCodes.includes(code)) {
      return true;
    }

    // Special case: CALL_EXCEPTION with "missing revert data" is likely a general RPC failure
    if (code === Logger.errors.CALL_EXCEPTION) {
      const message = error.message || '';
      if (message.includes('missing revert data')) {
        return true;
      }
      // All other CALL_EXCEPTIONs are actual contract reverts - not recoverable
      return false;
    }

    // Non-recoverable error codes
    const nonRecoverableCodes = [
      Logger.errors.INSUFFICIENT_FUNDS,
      Logger.errors.NONCE_EXPIRED,
      Logger.errors.REPLACEMENT_UNDERPRICED,
      Logger.errors.UNPREDICTABLE_GAS_LIMIT,
      Logger.errors.INVALID_ARGUMENT,
      Logger.errors.MISSING_ARGUMENT,
      Logger.errors.UNEXPECTED_ARGUMENT,
      Logger.errors.ACTION_REJECTED,
    ];

    if (nonRecoverableCodes.includes(code)) {
      return false;
    }

    // For other error types (network failures, connection errors, etc), consider recoverable
    // This includes errors without a code property
    return true;
  }

  /**
   * Performs failover across all providers, then retries with exponential backoff.
   */
  private async _performWithRetry(method: string, params: any): Promise<any> {
    let retryCount = 0;
    let delayMs = this.retryConfig.initialDelayMs;

    while (true) {
      // Try failover across all providers
      const result = await this._performFailover(method, params);

      // If successful, return immediately
      if (result.success) {
        return result.value;
      }

      // Check if error is recoverable
      if (!this._isRecoverableError(result.error)) {
        // Non-recoverable error - throw immediately without retry
        throw result.error;
      }

      // Check if we've exhausted retries
      if (retryCount >= this.retryConfig.maxRetries) {
        throw new Error(
          `All providers failed after ${retryCount} retries for ${method}: ${result.error.message}`,
        );
      }

      // Log retry attempt
      logger.warn(
        `Retry ${retryCount + 1}/${this.retryConfig.maxRetries} for ${method} after ${delayMs}ms delay`,
      );

      // Wait with exponential backoff
      await this._delay(delayMs);

      // Increase delay for next retry
      delayMs = Math.min(
        delayMs * this.retryConfig.backoffMultiplier,
        this.retryConfig.maxDelayMs,
      );
      retryCount++;
    }
  }

  /**
   * Tries each provider in sequence until one succeeds.
   * Returns success=true with value, or success=false with the last error.
   */
  private async _performFailover(
    method: string,
    params: any,
  ): Promise<{ success: true; value: any } | { success: false; error: any }> {
    let lastError: any = null;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const tStart = Date.now();
      console.log(
        `[DEBUG] MultiplexProvider._performFailover() - Trying provider ${i + 1}/${this.providers.length} for ${method}`,
      );

      try {
        const result = await provider.perform(method, params);
        console.log(
          `[DEBUG] MultiplexProvider._performFailover() - Provider ${i + 1} succeeded in (${Date.now() - tStart}ms) for ${method}`,
          params,
        );
        return { success: true, value: result };
      } catch (error) {
        const err = error as any;
        console.log(
          `[DEBUG] MultiplexProvider._performFailover() - Provider ${i + 1} failed (${Date.now() - tStart}ms) for ${method}:`,
          err.message,
        );
        if (err.code === Logger.errors.CALL_EXCEPTION && err.error) {
          console.error(err.error);
        }
        lastError = error;

        // If this is a non-recoverable error, return immediately
        if (!this._isRecoverableError(error)) {
          console.log(
            `[DEBUG] MultiplexProvider._performFailover() - Non-recoverable error, stopping failover`,
          );
          return { success: false, error };
        }

        // Continue to next provider for recoverable errors
        logger.debug(
          `Provider failed for ${method}, trying next provider: ${(error as Error).message}`,
        );
      }
    }

    // All providers failed
    console.log(
      `[DEBUG] MultiplexProvider._performFailover() - All providers failed for ${method}`,
    );
    return { success: false, error: lastError };
  }

  private async _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setLogLevel(level: string): void {
    const levelMap: Record<string, string> = {
      trace: 'DEBUG',
      debug: 'DEBUG',
      info: 'INFO',
      warn: 'WARNING',
      error: 'ERROR',
      fatal: 'ERROR',
      silent: 'OFF',
    };

    const ethersLevel = levelMap[level.toLowerCase()] || 'INFO';

    if (ethersLevel === 'OFF') {
      Logger.setLogLevel(Logger.levels.OFF);
    } else if (ethersLevel === 'DEBUG') {
      Logger.setLogLevel(Logger.levels.DEBUG);
    } else if (ethersLevel === 'WARNING') {
      Logger.setLogLevel(Logger.levels.WARNING);
    } else if (ethersLevel === 'ERROR') {
      Logger.setLogLevel(Logger.levels.ERROR);
    } else {
      Logger.setLogLevel(Logger.levels.INFO);
    }
  }
}
