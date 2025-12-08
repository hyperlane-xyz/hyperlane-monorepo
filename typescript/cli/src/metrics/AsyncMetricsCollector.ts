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
  private isShuttingDown = false;

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

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    process.on('beforeExit', () => this.flush());
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
  }

  // Non-blocking record method
  record(metric: RPCMetric) {
    // Just emit the event, return immediately
    this.emit('rpc_metric', metric);
  }

  private enqueue(metric: RPCMetric) {
    if (this.isShuttingDown) return;

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
      this.emit('flushed', batch.length);
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

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.flush(); // Final flush
    this.db.close();
    this.removeAllListeners();
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
