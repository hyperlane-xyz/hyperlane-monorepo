#!/usr/bin/env node
import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { createServiceLogger, rootLogger } from '@hyperlane-xyz/utils';

import { RelayerConfig } from './RelayerConfig.js';
import { RelayerService } from './RelayerService.js';

function getVersion(): string {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'),
    );
    return packageJson.version;
  } catch (error) {
    rootLogger.warn({ error }, 'Could not read version from package.json');
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const VERSION = getVersion();

  const configFile = process.env.RELAYER_CONFIG_FILE;
  const chainsEnv = process.env.RELAYER_CHAINS;
  const cacheFile = process.env.RELAYER_CACHE_FILE;
  const privateKey = process.env.HYP_KEY;

  if (!privateKey) {
    rootLogger.error('HYP_KEY environment variable is required');
    process.exit(1);
  }

  const logger = await createServiceLogger({
    service: 'relayer',
    version: VERSION,
  });

  const signer = new Wallet(privateKey);
  const enableMetrics = process.env.PROMETHEUS_ENABLED !== 'false';

  logger.info(
    {
      version: VERSION,
      configFile,
      chainsEnv,
      cacheFile,
      signerAddress: signer.address,
      enableMetrics,
    },
    'Starting Hyperlane Relayer Service',
  );

  try {
    let relayerConfig: RelayerConfig | undefined;
    if (configFile) {
      relayerConfig = RelayerConfig.load(configFile);
      logger.info('Loaded relayer configuration from file');
    }

    const registry = getRegistry({
      registryUris: [],
      enableProxy: false,
      logger: rootLogger,
    });
    logger.info('Initialized registry');

    const chainMetadata = await registry.getMetadata();
    logger.info(
      `Loaded metadata for ${Object.keys(chainMetadata).length} chains`,
    );

    const multiProvider = new MultiProvider(chainMetadata);
    multiProvider.setSharedSigner(signer);

    const chains = chainsEnv?.split(',').map((c) => c.trim());
    const whitelist = chains
      ? Object.fromEntries(chains.map((chain) => [chain, []]))
      : undefined;

    const service = new RelayerService(
      multiProvider,
      registry,
      {
        mode: 'daemon',
        cacheFile,
        logger,
        enableMetrics,
      },
      relayerConfig,
    );

    await service.start(whitelist);
  } catch (error) {
    logger.error({ error }, 'Failed to start relayer service');
    process.exit(1);
  }
}

main().catch((error) => {
  rootLogger.error({ error }, 'Fatal error');
  process.exit(1);
});
