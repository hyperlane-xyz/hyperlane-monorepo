import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { loadProtocolProviders } from '@hyperlane-xyz/deploy-sdk';
import {
  AltVM,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  ExplorerFamily,
  MultiProtocolProvider,
  MultiProvider,
  defaultMultiplexProviderBuilder,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { isSignCommand } from '../commands/signCommands.js';
import { readChainSubmissionStrategyConfig } from '../config/strategy.js';
import { getMetricsCollector } from '../metrics/AsyncMetricsCollector.js';
import { ENV } from '../utils/env.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';
import { getSigner } from '../utils/keys.js';

import { createAltVMSigners } from './altvm.js';
import { resolveChains } from './strategies/chain/chainResolver.js';
import { MultiProtocolSignerManager } from './strategies/signer/MultiProtocolSignerManager.js';
import {
  CommandContext,
  ContextSettings,
  SignerKeyProtocolMap,
  SignerKeyProtocolMapSchema,
} from './types.js';

export async function contextMiddleware(argv: Record<string, any>) {
  const requiresKey = isSignCommand(argv);

  // Precedence: CLI args > Environment variables > undefined
  const providerRetryOptions = {
    maxRetries:
      argv['max-retries'] ?? argv['maxRetries'] ?? ENV.HYP_MAX_RETRIES,
    baseRetryDelayMs:
      argv['retry-delay'] ?? argv['retryDelay'] ?? ENV.HYP_RETRY_DELAY,
    maxRetryDelayMs:
      argv['max-retry-delay'] ??
      argv['maxRetryDelay'] ??
      ENV.HYP_MAX_RETRY_DELAY,
    retryBackoffMultiplier:
      argv['retry-backoff'] ?? argv['retryBackoff'] ?? ENV.HYP_RETRY_BACKOFF,
  };

  const settings: ContextSettings = {
    registryUris: [...argv.registry],
    key: argv.key,
    requiresKey,
    disableProxy: argv.disableProxy,
    skipConfirmation: argv.yes,
    strategyPath: argv.strategy,
    authToken: argv.authToken,
    useMultiplex:
      argv['use-multiplex'] ??
      argv['useMultiplex'] ??
      ENV.HYP_USE_MULTIPLEX ??
      false,
    providerRetryOptions,
    metricsDbPath:
      argv['metrics-db-path'] ??
      argv['metricsDbPath'] ??
      ENV.HYP_METRICS_DB_PATH,
  };

  console.log(
    '[DEBUG] contextMiddleware - useMultiplex:',
    settings.useMultiplex,
  );
  console.log(
    '[DEBUG] contextMiddleware - providerRetryOptions:',
    settings.providerRetryOptions,
  );

  argv.context = await getContext(settings);
}

export async function signerMiddleware(argv: Record<string, any>) {
  const { key, requiresKey, strategyPath, multiProtocolProvider } =
    argv.context;

  const strategyConfig = strategyPath
    ? await readChainSubmissionStrategyConfig(strategyPath)
    : {};

  /**
   * Resolves chains based on the command type.
   */
  const chains = await resolveChains(argv);

  /**
   * Load and create AltVM Providers
   */
  const altVmChains = chains.filter(
    (chain) =>
      argv.context.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum,
  );

  try {
    await loadProtocolProviders(
      new Set(
        altVmChains.map((chain) =>
          argv.context.multiProvider.getProtocol(chain),
        ),
      ),
    );
  } catch (e) {
    throw new Error(
      `Failed to load providers in context for ${altVmChains.join(', ')}`,
      { cause: e },
    );
  }

  await Promise.all(
    altVmChains.map(async (chain) => {
      const { altVmProviders, multiProvider } = argv.context;
      const protocol = multiProvider.getProtocol(chain);
      const metadata = multiProvider.getChainMetadata(chain);

      if (hasProtocol(protocol))
        altVmProviders[chain] =
          await getProtocolProvider(protocol).createProvider(metadata);
    }),
  );

  if (!requiresKey) return argv;

  /**
   * Extracts signer config
   */
  const multiProtocolSigner = await MultiProtocolSignerManager.init(
    strategyConfig,
    chains,
    multiProtocolProvider,
    { key },
  );

  /**
   * @notice Attaches signers to MultiProvider and assigns it to argv.multiProvider
   */
  argv.context.multiProvider = await multiProtocolSigner.getMultiProvider();

  /**
   * Creates AltVM signers
   */
  argv.context.altVmSigners = await createAltVMSigners(
    argv.context.multiProvider,
    chains,
    key,
    strategyConfig,
  );

  return argv;
}

/**
 * Retrieves context for the user-selected command
 * @returns context for the current command
 */
export async function getContext({
  registryUris,
  key,
  requiresKey,
  skipConfirmation,
  disableProxy = false,
  strategyPath,
  authToken,
  useMultiplex = false,
  providerRetryOptions,
  metricsDbPath,
}: ContextSettings): Promise<CommandContext> {
  const registry = getRegistry({
    registryUris,
    enableProxy: !disableProxy,
    logger: rootLogger,
    authToken,
  });

  const { keyMap, ethereumSignerAddress } = await getSignerKeyMap(
    key,
    !!skipConfirmation,
  );

  const multiProvider = await getMultiProvider(registry, {
    useMultiplex,
    providerRetryOptions,
    metricsDbPath,
  });
  const multiProtocolProvider = await getMultiProtocolProvider(registry);

  // This mapping gets populated as part of signerMiddleware
  const altVmProviders: ChainMap<AltVM.IProvider> = {};

  const supportedProtocols = [
    ProtocolType.Ethereum,
    ProtocolType.CosmosNative,
    ProtocolType.Radix,
  ];

  return {
    registry,
    requiresKey,
    chainMetadata: multiProvider.metadata,
    multiProvider,
    multiProtocolProvider,
    altVmProviders,
    supportedProtocols,
    key: keyMap,
    skipConfirmation: !!skipConfirmation,
    signerAddress: ethereumSignerAddress,
    strategyPath,
  };
}

/**
 * Resolves private keys by protocol type by reading either the key
 * argument passed to the CLI or falling back to reading from env
 */
async function getSignerKeyMap(
  rawKeyMap: ContextSettings['key'],
  skipConfirmation: boolean,
): Promise<{ keyMap: SignerKeyProtocolMap; ethereumSignerAddress?: Address }> {
  const keyMap: SignerKeyProtocolMap = SignerKeyProtocolMapSchema.parse(
    rawKeyMap ?? {},
  );

  Object.values(ProtocolType).forEach((protocol) => {
    if (keyMap[protocol]) {
      return;
    }

    if (process.env[`HYP_KEY_${protocol.toUpperCase()}`]) {
      keyMap[protocol] = process.env[`HYP_KEY_${protocol.toUpperCase()}`];
      return;
    }

    if (protocol === ProtocolType.Ethereum && process.env.HYP_KEY) {
      keyMap[protocol] = process.env.HYP_KEY;
      return;
    }
  });

  // Just for backward compatibility
  let signerAddress: string | undefined = undefined;
  if (keyMap[ProtocolType.Ethereum]) {
    const { signer } = await getSigner({
      key: keyMap[ProtocolType.Ethereum],
      skipConfirmation,
    });
    signerAddress = await signer.getAddress();
  }

  return {
    keyMap,
    ethereumSignerAddress: signerAddress,
  };
}

/**
 * Retrieves a new MultiProvider based on all known chain metadata & custom user chains
 * @param registry The registry to get chain metadata from
 * @param settings Provider configuration settings
 * @param signer Optional signer to set on the MultiProvider
 * @returns a new MultiProvider
 */
async function getMultiProvider(
  registry: IRegistry,
  settings: Pick<
    ContextSettings,
    'useMultiplex' | 'providerRetryOptions' | 'metricsDbPath'
  >,
  signer?: ethers.Signer,
) {
  const chainMetadata = await registry.getMetadata();

  // Filter out undefined values from retry options
  const retryOptions = settings.providerRetryOptions
    ? Object.fromEntries(
        Object.entries(settings.providerRetryOptions).filter(
          ([_, v]) => v !== undefined && v !== null,
        ),
      )
    : undefined;

  // Create metrics collector if DB path is provided
  const metricsCollector = settings.metricsDbPath
    ? getMetricsCollector(settings.metricsDbPath)
    : null;

  console.log(
    '[DEBUG] getMultiProvider - metricsCollector:',
    metricsCollector ? `enabled (${settings.metricsDbPath})` : 'disabled',
  );

  // Select provider builder based on useMultiplex setting
  const providerBuilder = settings.useMultiplex
    ? (rpcUrls: any, network: any, retryOverride?: any) => {
        const result = defaultMultiplexProviderBuilder(
          rpcUrls,
          network,
          retryOverride || retryOptions,
          metricsCollector || undefined,
        );
        return result.provider;
      }
    : undefined; // Use default SmartProvider

  console.log(
    '[DEBUG] getMultiProvider - useMultiplex:',
    settings.useMultiplex,
  );
  console.log(
    '[DEBUG] getMultiProvider - providerBuilder:',
    providerBuilder ? 'MultiplexProvider' : 'SmartProvider (default)',
  );
  console.log('[DEBUG] getMultiProvider - retryOptions:', retryOptions);

  const multiProvider = new MultiProvider(chainMetadata, {
    providerBuilder,
  });

  if (signer) multiProvider.setSharedSigner(signer);
  return multiProvider;
}

async function getMultiProtocolProvider(registry: IRegistry) {
  const chainMetadata = await registry.getMetadata();
  return new MultiProtocolProvider(chainMetadata);
}

/**
 * Requests and saves Block Explorer API keys for the specified chains, prompting the user if necessary.
 *
 * @param chains - The list of chain names to request API keys for.
 * @param chainMetadata - The chain metadata, used to determine if an API key is already configured.
 * @param registry - The registry used to update the chain metadata with the new API key.
 * @returns A mapping of chain names to their API keys.
 */
export async function requestAndSaveApiKeys(
  chains: ChainName[],
  chainMetadata: ChainMap<ChainMetadata>,
  registry: IRegistry,
): Promise<ChainMap<string>> {
  const apiKeys: ChainMap<string> = {};

  for (const chain of chains) {
    const blockExplorer = chainMetadata[chain]?.blockExplorers?.[0];
    if (blockExplorer?.family !== ExplorerFamily.Etherscan) {
      continue;
    }
    if (blockExplorer?.apiKey) {
      apiKeys[chain] = blockExplorer.apiKey;
      continue;
    }
    const wantApiKey = await confirm({
      default: false,
      message: `Do you want to use an API key to verify on this (${chain}) chain's block explorer`,
    });
    if (wantApiKey) {
      apiKeys[chain] = await detectAndConfirmOrPrompt(
        async () => {
          const blockExplorers = chainMetadata[chain].blockExplorers;
          if (!(blockExplorers && blockExplorers.length > 0)) return;
          for (const blockExplorer of blockExplorers) {
            /* The current apiKeys mapping only accepts one key, even if there are multiple explorer options present. */
            if (blockExplorer.apiKey) return blockExplorer.apiKey;
          }
          return undefined;
        },
        `Enter an API key for the ${chain} explorer`,
        `${chain} api key`,
        `${chain} metadata blockExplorers config`,
      );
      chainMetadata[chain].blockExplorers![0].apiKey = apiKeys[chain];
      await registry.updateChain({
        chainName: chain,
        metadata: chainMetadata[chain],
      });
    }
  }

  return apiKeys;
}
