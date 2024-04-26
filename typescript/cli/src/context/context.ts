import { ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

import { SIGN_COMMANDS } from '../commands/signCommands.js';
import { forkNetworkToMultiProvider } from '../deploy/dry-run.js';
import { MergedRegistry } from '../registry/MergedRegistry.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { getImpersonatedSigner, getSigner } from '../utils/keys.js';

import {
  CommandContext,
  ContextSettings,
  WriteCommandContext,
} from './types.js';

export async function contextMiddleware(argv: Record<string, any>) {
  const commandName = argv._.length >= 2 ? argv._[1] : '';
  const isDryRun = !!argv.dryRun;
  const settings: ContextSettings = {
    commandName,
    registryUri: argv.registry,
    configOverrideUri: argv.configs,
    key: argv.key,
    skipConfirmation: argv.yes,
  };
  const context = isDryRun
    ? await getDryRunContext(settings, argv.chain)
    : await getContext(settings);
  argv.context = context;
}

/**
 * Retrieves context for the user-selected command
 * @returns context for the current command
 */
export async function getContext({
  commandName,
  registryUri,
  configOverrideUri,
  key,
  skipConfirmation,
}: ContextSettings): Promise<CommandContext> {
  const registry = getRegistry(registryUri, configOverrideUri);

  let signer: ethers.Wallet | undefined = undefined;
  if (SIGN_COMMANDS.includes(commandName)) {
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
  } as CommandContext;
}

/**
 * Retrieves dry-run context for the user-selected command
 * @returns dry-run context for the current command
 */
export async function getDryRunContext(
  { registryUri, configOverrideUri, key, skipConfirmation }: ContextSettings,
  chain?: ChainName,
): Promise<CommandContext> {
  const registry = getRegistry(registryUri, configOverrideUri, true);
  const chainMetadata = await registry.getMetadata();

  if (!chain) {
    if (skipConfirmation) throw new Error('No chains provided');
    chain = await runSingleChainSelectionStep(
      chainMetadata,
      'Select chain to dry-run against:',
    );
  }

  const multiProvider = await getMultiProvider(registry);
  await forkNetworkToMultiProvider(multiProvider, chain);
  const { key: impersonatedKey, signer: impersonatedSigner } =
    await getImpersonatedSigner({
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
  isDryRun?: boolean,
): IRegistry {
  return new MergedRegistry({
    registryUris: [primaryRegistryUri, overrideRegistryUri],
    isDryRun,
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
