#!/usr/bin/env node
import { Wallet } from 'ethers';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  getSignerForChain,
  HyperlaneIgp,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  applyRpcUrlOverridesFromEnv,
  createServiceLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { KeyFunderConfigLoader } from './config/KeyFunderConfig.js';
import { KeyFunder } from './core/KeyFunder.js';
import { KeyFunderMetrics } from './metrics/Metrics.js';
import { normalizeKeyFunderProtocol } from './utils.js';

async function main(): Promise<void> {
  const VERSION = process.env.SERVICE_VERSION ?? 'dev';

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

    const registryUri = process.env.REGISTRY_URI ?? DEFAULT_GITHUB_REGISTRY;
    const registry = getRegistry({
      registryUris: [registryUri],
      enableProxy: true,
      logger: rootLogger,
    });
    logger.info({ registryUri }, 'Initialized registry');

    const chainMetadata = await registry.getMetadata();
    const overriddenChains = applyRpcUrlOverridesFromEnv(chainMetadata, {
      chainNames: configuredChains,
    });
    if (overriddenChains.length > 0) {
      logger.info(
        { chains: overriddenChains, count: overriddenChains.length },
        'Applied RPC overrides from environment variables',
      );
    }
    logger.info(
      `Loaded metadata for ${Object.keys(chainMetadata).length} chains`,
    );

    const multiProvider = new MultiProvider(chainMetadata);
    const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);
    const signer = new Wallet(privateKey);
    multiProvider.setSharedSigner(signer);
    logger.info('Initialized providers with signer support');

    let igp: HyperlaneIgp | undefined;
    const igpEntries = Object.entries(config.chains)
      .filter(([, cfg]) => cfg.igp)
      .map(([chain, cfg]) => [
        chain,
        { interchainGasPaymaster: cfg.igp!.address },
      ]);

    if (igpEntries.length > 0) {
      const igpAddresses = Object.fromEntries(igpEntries);
      igp = HyperlaneIgp.fromAddressesMap(igpAddresses, multiProvider);
      logger.info(
        { chains: Object.keys(igpAddresses) },
        'Initialized IGP contracts',
      );
    }

    const metrics = new KeyFunderMetrics(
      config.metrics,
      config.metrics?.labels,
    );

    const signerCache = new Map<string, Awaited<ReturnType<typeof getSignerForChain>>>();

    const funder = new KeyFunder(multiProvider, multiProtocolProvider, config, {
      logger,
      metrics,
      skipIgpClaim: process.env.SKIP_IGP_CLAIM === 'true',
      igp,
      getSigner: async (chain) => {
        const cached = signerCache.get(chain);
        if (cached) return cached;

        const metadata = multiProtocolProvider.getChainMetadata(chain);
        const protocol = normalizeKeyFunderProtocol(metadata.protocol);
        const chainSigner = await getSignerForChain(
          chain,
          {
            protocol,
            privateKey,
          },
          multiProtocolProvider,
        );
        signerCache.set(chain, chainSigner);
        return chainSigner;
      },
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

main().catch((error) => {
  const err = error as Error;
  rootLogger.error({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
