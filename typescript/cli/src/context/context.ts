import { confirm } from '@inquirer/prompts';
import { Signer, ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { isSignCommand } from '../commands/signCommands.js';
import { readChainSubmissionStrategyConfig } from '../config/strategy.js';
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
    registryUris: [
      ...argv.registry,
      ...(argv.overrides ? [argv.overrides] : []),
    ],
    key: argv.key,
    fromAddress: argv.fromAddress,
    requiresKey,
    disableProxy: argv.disableProxy,
    skipConfirmation: argv.yes,
    strategyPath: argv.strategy,
    authToken: argv.authToken,
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
  const { key, requiresKey, multiProvider, strategyPath } = argv.context;

  if (!requiresKey) return argv;

  const strategyConfig = strategyPath
    ? await readChainSubmissionStrategyConfig(strategyPath)
    : {};

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
  registryUris,
  key,
  requiresKey,
  skipConfirmation,
  disableProxy = false,
  strategyPath,
  authToken,
}: ContextSettings): Promise<CommandContext> {
  const registry = getRegistry({
    registryUris,
    enableProxy: !disableProxy,
    logger: rootLogger,
    authToken,
  });

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
    strategyPath,
  } as CommandContext;
}

/**
 * Retrieves dry-run context for the user-selected command
 * @returns dry-run context for the current command
 */
export async function getDryRunContext(
  {
    registryUris,
    key,
    fromAddress,
    skipConfirmation,
    disableProxy = false,
    authToken,
  }: ContextSettings,
  chain?: ChainName,
): Promise<CommandContext> {
  const registry = getRegistry({
    registryUris,
    enableProxy: !disableProxy,
    logger: rootLogger,
    authToken,
  });
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
