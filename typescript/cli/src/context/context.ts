import { confirm } from '@inquirer/prompts';
import { Signer, ethers } from 'ethers';

import {
  DEFAULT_GITHUB_REGISTRY,
  GithubRegistry,
  IRegistry,
  MergedRegistry,
} from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { isHttpsUrl, isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_STRATEGY_CONFIG_PATH } from '../commands/options.js';
import { isSignCommand } from '../commands/signCommands.js';
import { safeReadChainSubmissionStrategyConfig } from '../config/strategy.js';
import { PROXY_DEPLOYED_URL } from '../consts.js';
import { forkNetworkToMultiProvider, verifyAnvil } from '../deploy/dry-run.js';
import { logBlue } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';
import { getImpersonatedSigner, getSigner } from '../utils/keys.js';

import { ChainResolverFactory } from './strategies/chain/ChainResolverFactory.js';
import { MultiProtocolSignerManager } from './strategies/signer/MultiProtocolSignerManager.js';
import {
  CommandContext,
  ContextSettings,
  WriteCommandContext,
} from './types.js';

export async function contextMiddleware(argv: Record<string, any>) {
  const isDryRun = !isNullish(argv.dryRun);
  const requiresKey = isSignCommand(argv);
  const settings: ContextSettings = {
    registryUri: argv.registry,
    registryOverrideUri: argv.overrides,
    key: argv.key,
    fromAddress: argv.fromAddress,
    requiresKey,
    disableProxy: argv.disableProxy,
    skipConfirmation: argv.yes,
    strategyPath: argv.strategy,
  };
  if (!isDryRun && settings.fromAddress)
    throw new Error(
      "'--from-address' or '-f' should only be used for dry-runs",
    );
  const context = isDryRun
    ? await getDryRunContext(settings, argv.dryRun)
    : await getContext(settings);
  argv.context = context;
}

export async function signerMiddleware(argv: Record<string, any>) {
  const { key, requiresKey, multiProvider, strategyPath, chainMetadata } =
    argv.context;

  const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);
  argv.multiProtocolProvider = multiProtocolProvider;
  if (!requiresKey) return argv;

  const strategyConfig = await safeReadChainSubmissionStrategyConfig(
    strategyPath ?? DEFAULT_STRATEGY_CONFIG_PATH,
  );

  /**
   * Intercepts Hyperlane command to determine chains.
   */
  const chainStrategy = ChainResolverFactory.getStrategy(argv);

  /**
   * Resolves chains based on the chain strategy.
   */
  const chains = await chainStrategy.resolveChains(argv);

  /**
   * Extracts signer config
   */
  const multiProtocolSigner = new MultiProtocolSignerManager(
    strategyConfig,
    chains,
    multiProvider,
    multiProtocolProvider,
    { key },
  );

  /**
   * @notice Attaches signers to MultiProvider and assigns it to argv.multiProvider
   */
  argv.multiProvider = await multiProtocolSigner.getMultiProvider();
  argv.multiProtocolSigner = multiProtocolSigner;

  return argv;
}

/**
 * Retrieves context for the user-selected command
 * @returns context for the current command
 */
export async function getContext({
  registryUri,
  registryOverrideUri,
  key,
  requiresKey,
  skipConfirmation,
  disableProxy = false,
}: ContextSettings): Promise<CommandContext> {
  const registry = getRegistry(registryUri, registryOverrideUri, !disableProxy);

  //Just for backward compatibility
  let signerAddress: string | undefined = undefined;
  if (key) {
    let signer: Signer;
    ({ key, signer } = await getSigner({ key, skipConfirmation }));
    signerAddress = await signer.getAddress();
  }

  const multiProvider = await getMultiProvider(registry);

  return {
    registry,
    requiresKey,
    chainMetadata: multiProvider.metadata,
    multiProvider,
    key,
    skipConfirmation: !!skipConfirmation,
    signerAddress,
  } as CommandContext;
}

/**
 * Retrieves dry-run context for the user-selected command
 * @returns dry-run context for the current command
 */
export async function getDryRunContext(
  {
    registryUri,
    registryOverrideUri,
    key,
    fromAddress,
    skipConfirmation,
    disableProxy = false,
  }: ContextSettings,
  chain?: ChainName,
): Promise<CommandContext> {
  const registry = getRegistry(registryUri, registryOverrideUri, !disableProxy);
  const chainMetadata = await registry.getMetadata();

  if (!chain) {
    if (skipConfirmation) throw new Error('No chains provided');
    chain = await runSingleChainSelectionStep(
      chainMetadata,
      'Select chain to dry-run against:',
    );
  }

  logBlue(`Dry-running against chain: ${chain}`);
  await verifyAnvil();

  let multiProvider = await getMultiProvider(registry);
  multiProvider = await forkNetworkToMultiProvider(multiProvider, chain);
  const { impersonatedKey, impersonatedSigner } = await getImpersonatedSigner({
    fromAddress,
    key,
    skipConfirmation,
  });
  multiProvider.setSharedSigner(impersonatedSigner);

  return {
    registry,
    chainMetadata: multiProvider.metadata,
    key: impersonatedKey,
    signer: impersonatedSigner,
    multiProvider: multiProvider,
    skipConfirmation: !!skipConfirmation,
    isDryRun: true,
    dryRunChain: chain,
  } as WriteCommandContext;
}

/**
 * Creates a new MergedRegistry using the provided URIs
 * The intention of the MergedRegistry is to join the common data
 * from a primary URI (such as the Hyperlane default Github repo)
 * and an override one (such as a local directory)
 * @returns a new MergedRegistry
 */
function getRegistry(
  primaryRegistryUri: string,
  overrideRegistryUri: string,
  enableProxy: boolean,
): IRegistry {
  const logger = rootLogger.child({ module: 'MergedRegistry' });
  const registries = [primaryRegistryUri, overrideRegistryUri]
    .map((uri) => uri.trim())
    .filter((uri) => !!uri)
    .map((uri, index) => {
      const childLogger = logger.child({ uri, index });
      if (isHttpsUrl(uri)) {
        return new GithubRegistry({
          uri,
          logger: childLogger,
          proxyUrl:
            enableProxy && isCanonicalRepoUrl(uri)
              ? PROXY_DEPLOYED_URL
              : undefined,
        });
      } else {
        return new FileSystemRegistry({
          uri,
          logger: childLogger,
        });
      }
    });
  return new MergedRegistry({
    registries,
    logger,
  });
}

function isCanonicalRepoUrl(url: string) {
  return url === DEFAULT_GITHUB_REGISTRY;
}

/**
 * Retrieves a new MultiProvider based on all known chain metadata & custom user chains
 * @param customChains Custom chains specified by the user
 * @returns a new MultiProvider
 */
async function getMultiProvider(registry: IRegistry, signer?: ethers.Signer) {
  const chainMetadata = await registry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);
  if (signer) multiProvider.setSharedSigner(signer);
  return multiProvider;
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
    if (chainMetadata[chain]?.blockExplorers?.[0]?.apiKey) {
      apiKeys[chain] = chainMetadata[chain]!.blockExplorers![0]!.apiKey!;
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
