import fs from 'fs';
import path from 'path';
import { DestinationStream, Logger, pino } from 'pino';

import { getLogLevel, rootLogger } from '../logging.js';

// Module-level state for log directory (per-chain file logging)
let logDir: string | undefined;

export function setLogDir(dir: string | undefined): void {
  logDir = dir;
  if (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function getLogDir(): string | undefined {
  return logDir;
}

// Cached file streams for per-chain logging
const chainStreams = new Map<string, DestinationStream>();

function getChainStream(chain: string): DestinationStream | undefined {
  if (!logDir) return undefined;

  if (!chainStreams.has(chain)) {
    const filePath = path.join(logDir, `${chain}.log`);
    chainStreams.set(chain, pino.destination(filePath));
  }
  return chainStreams.get(chain);
}

/**
 * Creates a logger that writes to both stdout and a chain-specific file.
 * If no log directory is configured, returns a standard logger.
 * File output is always JSON format; stdout follows the configured format.
 */
export function createChainLogger(chain: string, module?: string): Logger {
  const bindings = { chain, ...(module ? { module } : {}) };

  if (!logDir) {
    return rootLogger.child(bindings);
  }

  const chainStream = getChainStream(chain);
  if (!chainStream) {
    return rootLogger.child(bindings);
  }

  // Create multistream for dual output: stdout + chain file
  const streams: pino.StreamEntry[] = [
    { stream: process.stdout },
    { stream: chainStream },
  ];

  return pino({ level: getLogLevel() }, pino.multistream(streams)).child(
    bindings,
  );
}
