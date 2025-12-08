/* eslint-disable no-console */
import { Logger } from '@ethersproject/logger';
import { Network, Networkish } from '@ethersproject/networks';
import {
  BaseProvider,
  JsonRpcProvider,
  StaticJsonRpcProvider,
} from '@ethersproject/providers';

import type { RPCMetricsEmitter } from './types.js';

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
 * MultiplexProvider with round-robin load balancing, failover, and exponential backoff retry logic.
 *
 * Strategy:
 * 1. Distribute requests across providers using round-robin
 * 2. If a provider fails with recoverable error, try next provider in round-robin order
 * 3. When all providers fail with recoverable errors, retry with exponential backoff
 * 4. Stop immediately on non-recoverable errors
 */
export class MultiplexProvider extends BaseProvider {
  readonly providers: JsonRpcProvider[];
  readonly retryConfig: RetryConfig;
  private _detectNetworkCallCount = 0;
  private _providerInFlightCounts: number[] = [];
  private _nextProviderIndex = 0; // Round-robin counter
  private _metricsEmitter?: RPCMetricsEmitter; // Optional metrics emitter
  private _providerUrls: string[]; // Store URLs for metrics

  constructor(
    urls: string[],
    network?: Networkish,
    retryConfig?: Partial<RetryConfig>,
    metricsEmitter?: RPCMetricsEmitter,
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
    console.log(
      '[DEBUG] MultiplexProvider constructor - Metrics:',
      metricsEmitter ? 'enabled' : 'disabled',
    );

    // If network is known, pass it; otherwise use "any" for dynamic detection
    super(network || 'any');

    this.setLogLevel(Logger.levels.DEBUG);
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this._metricsEmitter = metricsEmitter;
    this._providerUrls = urls;

    this.providers = urls.map((url) => {
      // Use StaticJsonRpcProvider for CLI use case - network doesn't change
      // This avoids repeated detectNetwork() calls that JsonRpcProvider does
      const provider = new StaticJsonRpcProvider(url, network || 'any');
      provider.polling = false; // Disable - we'll handle polling at the multiplex level
      return provider;
    });

    // Initialize in-flight counters for each provider
    this._providerInFlightCounts = new Array(urls.length).fill(0);
  }

  async detectNetwork(): Promise<Network> {
    // Increment call counter
    const callNum = ++this._detectNetworkCallCount;

    // Cache detection to avoid redundant work from multiple concurrent calls
    if (this._networkDetectionPromise) {
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
          logger.warn(
            `Network mismatch: expected chainId ${expectedNetwork.chainId}, got ${network.chainId} from provider`,
          );
        } else {
          console.log(
            `[DEBUG] MultiplexProvider._verifyNetworkConsistency() - Provider ${i + 1} OK (chainId=${network.chainId})`,
          );
        }
      } catch (error) {
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
   * Extracts contract address and function signature from RPC params.
   */
  private _extractCallDetails(
    method: string,
    params: any,
  ): { contractAddress?: string; functionSignature?: string } {
    try {
      // For eth_call, params is typically { transaction: { to, data }, blockTag }
      if (method === 'call' && params?.transaction) {
        const contractAddress = params.transaction.to;
        const data = params.transaction.data;

        // Extract function selector (first 4 bytes = 8 hex chars after 0x)
        const functionSignature =
          data && typeof data === 'string' && data.startsWith('0x')
            ? data.slice(0, 10)
            : undefined;

        return { contractAddress, functionSignature };
      }
    } catch (error) {
      // Ignore extraction errors - metrics collection shouldn't break RPC calls
    }
    return {};
  }

  /**
   * Extracts error details, including nested error information and reason fields.
   */
  private _extractErrorDetails(error: any): {
    errorType: string;
    errorMessage: string;
  } {
    const errorType = error.code || 'unknown';
    let errorMessage = error.message || String(error);

    // Collect additional error context
    const contextParts = [];

    // If there's a reason field, include it (common in ethers errors)
    if (error.reason && error.reason !== errorMessage) {
      contextParts.push(`reason: ${error.reason}`);
    }

    // For timeout errors, include the timeout duration
    if (error.timeout !== undefined) {
      contextParts.push(`timeout: ${error.timeout}ms`);
    }

    // For errors with nested error object, extract additional details
    if (error.error) {
      const nestedError = error.error;
      const nestedCode = nestedError.code;
      const nestedMessage = nestedError.message;

      // Append nested error details
      const nestedDetails = [];
      if (nestedCode !== undefined) nestedDetails.push(`code=${nestedCode}`);
      if (nestedMessage) nestedDetails.push(`message=${nestedMessage}`);

      if (nestedDetails.length > 0) {
        contextParts.push(`nested: ${nestedDetails.join(', ')}`);
      }
    }

    // Build final error message with all context
    if (contextParts.length > 0) {
      errorMessage = `${errorMessage} (${contextParts.join('; ')})`;
    }

    return { errorType, errorMessage };
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
   * Tries providers in round-robin order until one succeeds.
   * Returns success=true with value, or success=false with the last error.
   */
  private async _performFailover(
    method: string,
    params: any,
  ): Promise<{ success: true; value: any } | { success: false; error: any }> {
    let lastError: any = null;

    // Extract call details once for all attempts
    const { contractAddress, functionSignature } = this._extractCallDetails(
      method,
      params,
    );

    // Get starting provider index for round-robin, then increment for next call
    const startIndex = this._nextProviderIndex;
    this._nextProviderIndex =
      (this._nextProviderIndex + 1) % this.providers.length;

    // Try all providers starting from the round-robin position
    for (let offset = 0; offset < this.providers.length; offset++) {
      const i = (startIndex + offset) % this.providers.length;
      const provider = this.providers[i];
      const tStart = Date.now();

      // Increment in-flight counter for this provider
      this._providerInFlightCounts[i]++;

      try {
        const result = await provider.perform(method, params);

        // Decrement in-flight counter
        this._providerInFlightCounts[i]--;

        const durationMs = Date.now() - tStart;

        console.log(
          `[DEBUG] MultiplexProvider._performFailover() - Provider ${i + 1} succeeded in ${durationMs}ms for ${method} (in-flight: ${this._providerInFlightCounts[i]})`,
          params,
        );

        // Emit success metric
        if (this._metricsEmitter) {
          this._metricsEmitter.emit('rpc_metric', {
            provider: this._providerUrls[i],
            method,
            contractAddress,
            functionSignature,
            durationMs,
            success: true,
            chainId:
              typeof this.network === 'object'
                ? this.network.chainId
                : undefined,
          });
        }

        return { success: true, value: result };
      } catch (error) {
        // Decrement in-flight counter
        this._providerInFlightCounts[i]--;

        const durationMs = Date.now() - tStart;
        const err = error as any;

        console.log(
          `[DEBUG] MultiplexProvider._performFailover() - Provider ${i + 1} failed in ${durationMs}ms for ${method} (in-flight: ${this._providerInFlightCounts[i]})`,
        );
        if (err.code === Logger.errors.CALL_EXCEPTION && err.error) {
          console.error(err.error);
        } else {
          console.error(err);
        }

        // Emit failure metric with enhanced error details
        if (this._metricsEmitter) {
          const { errorType, errorMessage } = this._extractErrorDetails(err);
          this._metricsEmitter.emit('rpc_metric', {
            provider: this._providerUrls[i],
            method,
            contractAddress,
            functionSignature,
            durationMs,
            success: false,
            errorType,
            errorMessage,
            chainId:
              typeof this.network === 'object'
                ? this.network.chainId
                : undefined,
          });
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
