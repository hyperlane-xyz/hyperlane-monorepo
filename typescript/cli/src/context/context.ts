import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  GithubRegistry,
  IRegistry,
  MergedRegistry,
} from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  MultiProvider,
  SubmissionStrategy,
  SubmissionStrategySchema,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { isHttpsUrl, isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { isSignCommand } from '../commands/signCommands.js';
import { forkNetworkToMultiProvider, verifyAnvil } from '../deploy/dry-run.js';
import { logBlue } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';
import { getImpersonatedSigner, getSigner } from '../utils/keys.js';

import {
  CommandContext,
  ContextSettings,
  WriteCommandContext,
} from './types.js';

export async function contextMiddleware(argv: Record<string, any>) {
  let isDryRun = !isNullish(argv.dryRun);
  const requiresKey = isSignCommand(argv);
  const settings: ContextSettings = {
    registryUri: argv.registry,
    registryOverrideUri: argv.overrides,
    key: argv.key,
    fromAddress: argv.fromAddress,
    requiresKey,
    skipConfirmation: argv.yes,
  };
  if (!isDryRun && settings.fromAddress)
    throw new Error(
      "'--from-address' or '-f' should only be used for dry-runs",
    );
  if (argv.strategy) {
    settings.submissionStrategy = getSubmissionStrategy(argv.strategy);
    if (
      settings.submissionStrategy.submitter.type ===
      TxSubmitterType.IMPERSONATED_ACCOUNT
    ) {
      isDryRun = true;
    }
  }
  const context = isDryRun
    ? await getDryRunContext(settings, argv.dryRun)
    : await getContext(settings);
  argv.context = context;
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
  submissionStrategy,
}: ContextSettings): Promise<CommandContext> {
  const registry = getRegistry(registryUri, registryOverrideUri);

  let signer: ethers.Wallet | undefined = undefined;
  if (key || requiresKey) {
    ({ key, signer } = await getSigner({ key, skipConfirmation }));
  }
  const multiProvider = await getMultiProvider(registry, signer);

  return {
    registry,
    chainMetadata: multiProvider.metadata,
    multiProvider,
    key,
    signer,
    skipConfirmation: !!skipConfirmation,
    submissionStrategy,
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
    submissionStrategy,
  }: ContextSettings,
  chain?: ChainName,
): Promise<CommandContext> {
  const registry = getRegistry(registryUri, registryOverrideUri);
  const chainMetadata = await registry.getMetadata();

  if (!chain) {
    if (skipConfirmation) throw new Error('No chains provided');
    chain = submissionStrategy
      ? submissionStrategy.chain
      : await runSingleChainSelectionStep(
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
    submissionStrategy,
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
): IRegistry {
  const logger = rootLogger.child({ module: 'MergedRegistry' });
  const registries = [primaryRegistryUri, overrideRegistryUri]
    .map((uri) => uri.trim())
    .filter((uri) => !!uri)
    .map((uri, index) => {
      const childLogger = logger.child({ uri, index });
      if (isHttpsUrl(uri)) {
        return new GithubRegistry({ uri, logger: childLogger });
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
 * Retrieves a submission strategy from the provided filepath.
 * @param submissionStrategyFilepath a filepath to the submission strategy file
 * @returns a formatted submission strategy
 */
function getSubmissionStrategy(
  submissionStrategyFilepath: string,
): SubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return SubmissionStrategySchema.parse(submissionStrategyFileContent);
}

export async function getOrRequestApiKeys(
  chains: ChainName[],
  chainMetadata: ChainMap<ChainMetadata>,
): Promise<ChainMap<string>> {
  const apiKeys: ChainMap<string> = {};

  for (const chain of chains) {
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
    }
  }

  return apiKeys;
}
