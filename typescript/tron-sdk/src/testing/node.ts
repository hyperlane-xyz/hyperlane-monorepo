/* eslint-disable import/no-nodejs-modules */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { rootLogger, sleep } from '@hyperlane-xyz/utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extended test chain metadata for Tron
 */
export interface TronTestChainMetadata {
  name: string;
  chainId: number;
  rpcPort: number; // JSON-RPC port (8545)
  httpPort: number; // HTTP API port (8090)
}

/**
 * Get the path to the local-node directory
 */
export function getLocalNodeDir(): string {
  return join(__dirname, '..', '..', 'local-node');
}

/**
 * Starts a local Tron node using shell commands (docker-compose)
 *
 * @param chainMetadata - Test chain metadata configuration
 */
export async function runTronNodeWithShell(
  chainMetadata: TronTestChainMetadata,
): Promise<void> {
  const { execSync } = await import('child_process');
  const localNodeDir = getLocalNodeDir();

  rootLogger.info(`Starting Tron node from ${localNodeDir}`);

  // Export environment variables and start docker-compose
  const env = {
    ...process.env,
    TRON_JSON_RPC_PORT: chainMetadata.rpcPort.toString(),
    TRON_HTTP_PORT: chainMetadata.httpPort.toString(),
    TRON_CHAIN_ID: chainMetadata.chainId.toString(),
  };

  execSync('docker-compose up -d', {
    cwd: localNodeDir,
    env,
    stdio: 'inherit',
  });

  // Wait for the node to start
  rootLogger.info('Waiting for Tron node to initialize...');
  await sleep(30_000);
}

/**
 * Stops a Tron node started with runTronNodeWithShell
 */
export async function stopTronNodeWithShell(): Promise<void> {
  const { execSync } = await import('child_process');
  const localNodeDir = getLocalNodeDir();

  rootLogger.info('Stopping Tron node');

  execSync('docker-compose down', {
    cwd: localNodeDir,
    stdio: 'inherit',
  });
}
