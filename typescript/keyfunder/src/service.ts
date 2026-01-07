#!/usr/bin/env node
import { Wallet } from 'ethers';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { HyperlaneIgp, MultiProvider } from '@hyperlane-xyz/sdk';
import { createServiceLogger, rootLogger } from '@hyperlane-xyz/utils';

import { KeyFunderConfigLoader } from './config/KeyFunderConfig.js';
import { KeyFunder } from './core/KeyFunder.js';
import { KeyFunderMetrics } from './metrics/Metrics.js';

async function main(): Promise<void> {
  const VERSION = process.env.SERVICE_VERSION || 'dev';

  const configFile = process.env.KEYFUNDER_CONFIG_FILE;
  if (!configFile) {
    rootLogger.error('KEYFUNDER_CONFIG_FILE environment variable is required');
    process.exit(1);
  }

  const logger = await createServiceLogger({
    service: 'keyfunder',
    version: VERSION,
  });

  logger.info(
    { version: VERSION, configFile },
    'Starting Hyperlane KeyFunder Service',
  );

  try {
    const configLoader = KeyFunderConfigLoader.load(configFile);
    const config = configLoader.config;
    logger.info('Loaded keyfunder configuration');

    const privateKeyEnvVar = configLoader.getFunderPrivateKeyEnvVar();
    const privateKey = process.env[privateKeyEnvVar];
    if (!privateKey) {
      throw new Error(`${privateKeyEnvVar} environment variable is required`);
    }

    const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
    const registry = getRegistry({
      registryUris: [registryUri],
      enableProxy: true,
      logger: rootLogger,
    });
    logger.info({ registryUri }, 'Initialized registry');

    const chainMetadata = await registry.getMetadata();
    applyRpcOverrides(chainMetadata, configLoader.getConfiguredChains());
    logger.info(
      `Loaded metadata for ${Object.keys(chainMetadata).length} chains`,
    );

    const multiProvider = new MultiProvider(chainMetadata);
    const signer = new Wallet(privateKey);
    multiProvider.setSharedSigner(signer);
    logger.info('Initialized MultiProvider with signer');

    let igp: HyperlaneIgp | undefined;
    const chainsWithIgp = Object.entries(config.chains)
      .filter(([, cfg]) => cfg.igp)
      .map(([chain]) => chain);

    if (chainsWithIgp.length > 0) {
      const addresses = await registry.getAddresses();
      const igpAddresses = Object.fromEntries(
        chainsWithIgp
          .filter((chain) => addresses[chain])
          .map((chain) => [chain, addresses[chain]]),
      );
      igp = HyperlaneIgp.fromAddressesMap(igpAddresses, multiProvider);
      logger.info({ chains: chainsWithIgp }, 'Initialized IGP contracts');
    }

    const metrics = new KeyFunderMetrics(
      config.metrics,
      config.metrics?.labels,
    );

    const funder = new KeyFunder(multiProvider, config, {
      logger,
      metrics,
      skipIgpClaim: process.env.SKIP_IGP_CLAIM === 'true',
      igp,
    });

    await funder.fundAllChains();

    await metrics.push();
    logger.info('Metrics pushed to gateway');

    logger.info('KeyFunder completed successfully');
    process.exit(0);
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, stack: err.stack }, 'KeyFunder failed');
    process.exit(1);
  }
}

function applyRpcOverrides(
  chainMetadata: Record<string, { rpcUrls?: Array<{ http: string }> }>,
  configuredChains: string[],
): void {
  for (const chain of configuredChains) {
    const envVarName = `RPC_URL_${chain.toUpperCase().replace(/-/g, '_')}`;
    const rpcOverride = process.env[envVarName];
    if (rpcOverride && chainMetadata[chain]) {
      chainMetadata[chain].rpcUrls = [{ http: rpcOverride }];
    }
  }
}

main().catch((error) => {
  const err = error as Error;
  rootLogger.error({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
