#!/usr/bin/env node
import { Wallet } from 'ethers';
import { z } from 'zod';

import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { createServiceLogger, rootLogger } from '@hyperlane-xyz/utils';

import type { RelayerConfigInput } from '../config/schema.js';

import { loadConfig } from './RelayerConfig.js';
import { RelayerService } from './RelayerService.js';

const EnvSchema = z.object({
  RELAYER_CONFIG_FILE: z.string().optional(),
  RELAYER_CHAINS: z.string().optional(),
  RELAYER_CACHE_FILE: z.string().optional(),
  HYP_KEY: z.string().min(1),
  PROMETHEUS_ENABLED: z.enum(['true', 'false']).optional(),
  SERVICE_VERSION: z.string().optional(),
});

// Environment overrides take precedence over file config. If RELAYER_CHAINS is
// provided, it supersedes any whitelist in the file.
function mergeRelayerConfig(
  base?: RelayerConfigInput,
  overrides?: RelayerConfigInput,
): RelayerConfigInput | undefined {
  if (!base && !overrides) return undefined;
  const merged = { ...base, ...overrides };
  if (overrides?.chains) {
    delete merged.whitelist;
  }
  return merged;
}

async function main(): Promise<void> {
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    rootLogger.error(
      { issues: envResult.error.issues },
      'Invalid environment variables',
    );
    process.exit(1);
  }
  const env = envResult.data;

  const VERSION = env.SERVICE_VERSION || 'dev';

  const configFile = env.RELAYER_CONFIG_FILE;
  const chainsEnv = env.RELAYER_CHAINS;
  const cacheFile = env.RELAYER_CACHE_FILE;
  const privateKey = env.HYP_KEY;

  const logger = await createServiceLogger({
    service: 'relayer',
    version: VERSION,
  });

  const signer = new Wallet(privateKey);
  const enableMetrics = env.PROMETHEUS_ENABLED !== 'false';

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
    let fileConfig: RelayerConfigInput | undefined;
    if (configFile) {
      fileConfig = loadConfig(configFile);
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

    const chains = chainsEnv
      ? chainsEnv
          .split(',')
          .map((c) => c.trim())
          .filter((chain) => chain.length > 0)
      : undefined;

    let envConfig: RelayerConfigInput | undefined;
    if (chains?.length || cacheFile) {
      envConfig = {};
      if (chains?.length) {
        envConfig.chains = chains;
      }
      if (cacheFile) {
        envConfig.cacheFile = cacheFile;
      }
    }

    const relayerConfig = mergeRelayerConfig(fileConfig, envConfig);

    const service = await RelayerService.create(multiProvider, registry, {
      logger,
      enableMetrics,
      relayerConfig,
    });

    await service.start();
  } catch (error) {
    logger.error({ error }, 'Failed to start relayer service');
    process.exit(1);
  }
}

main().catch((error) => {
  rootLogger.error({ error }, 'Fatal error');
  process.exit(1);
});
