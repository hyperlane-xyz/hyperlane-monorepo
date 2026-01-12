#!/usr/bin/env node
import { Wallet } from 'ethers';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { ChainMetadata, HyperlaneIgp, MultiProvider } from '@hyperlane-xyz/sdk';
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

  const privateKey = process.env.HYP_KEY;
  if (!privateKey) {
    rootLogger.error('HYP_KEY environment variable is required');
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
    const configuredChains = configLoader.getConfiguredChains();
    logger.info({ chains: configuredChains }, 'Loaded keyfunder configuration');

    const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
    const registry = getRegistry({
      registryUris: [registryUri],
      enableProxy: true,
      logger: rootLogger,
    });
    logger.info({ registryUri }, 'Initialized registry');

    const chainMetadata = await registry.getMetadata();
    applyRpcOverrides(chainMetadata, configuredChains);
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
        chainsWithIgp.flatMap((chain) => {
          const igpConfig = config.chains[chain]?.igp;
          if (!igpConfig) {
            return [];
          }

          const registryChainAddresses = addresses[chain] ?? {};
          const merged = {
            ...registryChainAddresses,
            // Prefer config-provided IGP address, fall back to registry if needed.
            interchainGasPaymaster:
              igpConfig.address ??
              registryChainAddresses.interchainGasPaymaster,
          };

          if (!merged.interchainGasPaymaster) {
            logger.warn(
              { chain },
              'No IGP address found (config or registry), skipping IGP initialization for chain',
            );
            return [];
          }

          return [[chain, merged]];
        }),
      );

      if (Object.keys(igpAddresses).length === 0) {
        logger.warn(
          { chainsWithIgp },
          'IGP configured but no usable IGP addresses were found; skipping IGP initialization',
        );
      } else {
        igp = HyperlaneIgp.fromAddressesMap(igpAddresses, multiProvider);
        logger.info(
          { chains: Object.keys(igpAddresses) },
          'Initialized IGP contracts',
        );
      }
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

    let fundingError: Error | undefined;
    try {
      await funder.fundAllChains();
    } catch (error) {
      fundingError = error as Error;
    }

    // Always push metrics, even on failure (matches original fund-keys-from-deployer.ts behavior)
    await metrics.push();
    logger.info('Metrics pushed to gateway');

    if (fundingError) {
      throw fundingError;
    }

    logger.info('KeyFunder completed successfully');
    process.exit(0);
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, stack: err.stack }, 'KeyFunder failed');
    process.exit(1);
  }
}

function applyRpcOverrides(
  chainMetadata: Record<string, Partial<ChainMetadata>>,
  configuredChains: string[],
): void {
  for (const chain of configuredChains) {
    const envVarName = `RPC_URL_${chain.toUpperCase().replace(/-/g, '_')}`;
    const rpcUrl = process.env[envVarName];
    if (rpcUrl && chainMetadata[chain]) {
      rootLogger.debug(
        { chain, envVarName },
        'Using RPC from environment variable',
      );
      chainMetadata[chain].rpcUrls = [
        { http: rpcUrl },
      ] as ChainMetadata['rpcUrls'];
    }
  }
}

main().catch((error) => {
  const err = error as Error;
  rootLogger.error({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
