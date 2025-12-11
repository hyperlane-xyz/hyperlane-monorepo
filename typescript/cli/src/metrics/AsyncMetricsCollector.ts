import Database from 'better-sqlite3';
import { EventEmitter } from 'events';

import type { RPCMetric } from '@hyperlane-xyz/sdk';

class AsyncMetricsCollector extends EventEmitter {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private queue: Array<RPCMetric & { timestamp: number }> = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly batchSize = 100;
  private readonly flushIntervalMs = 5000; // 5 seconds
  private readonly maxQueueSize = 1000; // Limit queue growth
  private isShuttingDown = false;
  private lastCheckpointTime = Date.now();
  private readonly checkpointIntervalMs = 30000; // 30 seconds

  // Store signal handler references for proper cleanup
  private sigintHandler = () => {
    this.shutdown();
    process.exit(0); // Exit cleanly after shutdown
  };

  private sigtermHandler = () => {
    this.shutdown();
    process.exit(0);
  };

  private beforeExitHandler = () => {
    this.flush();
  };

  constructor(dbPath: string = './rpc_metrics.db') {
    super();
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');

    this.initSchema();

    this.insertStmt = this.db.prepare(`
      INSERT INTO rpc_metrics (
        timestamp, provider, method, contract_address,
        function_signature, duration_ms, success,
        error_type, error_message, block_number, chain_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Set up automatic flush
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);

    // Listen to our own events
    this.on('rpc_metric', (metric: RPCMetric) => {
      this.enqueue(metric);
    });

    // Graceful shutdown - use process.once() to prevent handler stacking
    process.once('SIGINT', this.sigintHandler);
    process.once('SIGTERM', this.sigtermHandler);
    process.once('beforeExit', this.beforeExitHandler);
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rpc_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        method TEXT NOT NULL,
        contract_address TEXT,
        function_signature TEXT,
        duration_ms INTEGER NOT NULL,
        success BOOLEAN NOT NULL,
        error_type TEXT,
        error_message TEXT,
        block_number INTEGER,
        chain_id INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON rpc_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_provider ON rpc_metrics(provider);
      CREATE INDEX IF NOT EXISTS idx_method ON rpc_metrics(method);
      CREATE INDEX IF NOT EXISTS idx_success ON rpc_metrics(success);
    `);

    // Configure WAL checkpoint behavior to prevent blocking
    // Disable auto-checkpoint - we'll control it manually
    this.db.pragma('wal_autocheckpoint = 0');

    // Set busy timeout to prevent immediate failures
    this.db.pragma('busy_timeout = 5000'); // 5 seconds

    // Optimize for write performance
    this.db.pragma('synchronous = NORMAL'); // Less paranoid than FULL
    this.db.pragma('cache_size = -64000'); // 64MB cache
  }

  // Non-blocking record method
  record(metric: RPCMetric) {
    // Just emit the event, return immediately
    this.emit('rpc_metric', metric);
  }

  /**
   * Performs a WAL checkpoint if enough time has passed.
   * Uses PASSIVE mode to avoid blocking if database is busy.
   */
  private checkpointIfNeeded() {
    const now = Date.now();
    if (now - this.lastCheckpointTime > this.checkpointIntervalMs) {
      try {
        // PASSIVE mode: checkpoint if safe, don't block otherwise
        this.db.pragma('wal_checkpoint(PASSIVE)');
        this.lastCheckpointTime = now;
      } catch (error) {
        // Log but don't fail - checkpoint is optional optimization
        console.debug('WAL checkpoint skipped:', error);
      }
    }
  }

  private enqueue(metric: RPCMetric) {
    if (this.isShuttingDown) return;

    // Drop metrics if queue is full to prevent unbounded growth
    if (this.queue.length >= this.maxQueueSize) {
      console.warn(
        `Metrics queue full (${this.maxQueueSize} items), dropping metric`,
      );
      return;
    }

    this.queue.push({
      ...metric,
      timestamp: Date.now(),
    });

    // Auto-flush if batch size reached
    if (this.queue.length >= this.batchSize) {
      setImmediate(() => this.flush());
    }
  }

  private flush() {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    const flushStart = Date.now();

    try {
      // Use a transaction for batch insert - much faster
      const insert = this.db.transaction((metrics: typeof batch) => {
        for (const metric of metrics) {
          this.insertStmt.run(
            metric.timestamp,
            metric.provider,
            metric.method,
            metric.contractAddress || null,
            metric.functionSignature || null,
            metric.durationMs,
            metric.success ? 1 : 0,
            metric.errorType || null,
            metric.errorMessage || null,
            metric.blockNumber || null,
            metric.chainId || null,
          );
        }
      });

      insert(batch);

      const flushDuration = Date.now() - flushStart;

      // Log slow flushes for debugging
      if (flushDuration > 100) {
        console.debug(
          `Metrics flush took ${flushDuration}ms for ${batch.length} items`,
        );
      }

      this.emit('flushed', batch.length);

      // Periodic checkpoint after successful flush
      this.checkpointIfNeeded();
    } catch (error) {
      console.error('Failed to flush metrics:', error);
      // Re-queue on failure (optional - could also just log)
      this.queue.unshift(...batch);
    }
  }

  shutdown() {
    if (this.isShuttingDown) return;

    console.log('Shutting down metrics collector...');
    this.isShuttingDown = true;

    // Clear the flush interval
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush of remaining metrics
    this.flush();

    // Final checkpoint before closing (TRUNCATE mode: complete checkpoint)
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      console.debug('Final WAL checkpoint failed:', error);
    }

    // Close database
    this.db.close();

    // Remove event emitter listeners
    this.removeAllListeners();

    // NOTE: Don't call process.exit() here - the signal handlers do that.
    // This allows shutdown() to be called from other contexts without forcing exit.
  }

  // Optional: Get queue size for monitoring
  get queueSize() {
    return this.queue.length;
  }
}

// Singleton
let metricsInstance: AsyncMetricsCollector | null = null;

export function getMetricsCollector(
  dbPath?: string,
): AsyncMetricsCollector | null {
  // If no dbPath provided and no instance exists, return null (metrics disabled)
  if (!dbPath && !metricsInstance) {
    return null;
  }

  // Create instance if needed
  if (!metricsInstance && dbPath) {
    metricsInstance = new AsyncMetricsCollector(dbPath);
  }

  return metricsInstance;
}

export function shutdownMetricsCollector() {
  if (metricsInstance) {
    metricsInstance.shutdown();
    metricsInstance = null;
  }
}
