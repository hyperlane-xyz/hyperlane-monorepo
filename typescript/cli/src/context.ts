import { ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { objKeys } from '@hyperlane-xyz/utils';

import { forkNetworkToMultiProvider } from './deploy/dry-run.js';
import { MergedRegistry } from './registry/MergedRegistry.js';
import { runSingleChainSelectionStep } from './utils/chains.js';
import { getImpersonatedSigner, getSigner } from './utils/keys.js';

export type KeyConfig = {
  key?: string;
  promptMessage?: string;
};

export interface ContextSettings {
  chains?: ChainName[];
  registryUri?: string;
  configOverrideUri?: string;
  coreConfig?: {
    coreArtifactsPath?: string;
    promptMessage?: string;
  };
  keyConfig?: KeyConfig;
  skipConfirmation?: boolean;
  warpConfig?: {
    warpConfigPath?: string;
    promptMessage?: string;
  };
}

interface CommandContextBase {
  chains: ChainName[];
  multiProvider: MultiProvider;
  registry: IRegistry;
}

// This makes return type dynamic based on the input settings
type CommandContext<P extends ContextSettings> = CommandContextBase &
  (P extends { keyConfig: object }
    ? { signer: ethers.Signer }
    : { signer: undefined });

/**
 * Retrieves context for the user-selected command
 * @returns context for the current command
 */
export async function getContext<P extends ContextSettings>(
  args: P,
): Promise<CommandContext<P>> {
  const registry = getRegistry(args.registryUri, args.configOverrideUri);
  const chains = await registry.getChains();

  const signer = await getSigner(args);
  const multiProvider = await getMultiProvider(registry, signer);

  return {
    chains,
    registry,
    signer,
    multiProvider,
  } as CommandContext<P>;
}

/**
 * Retrieves dry-run context for the user-selected command
 * @returns dry-run context for the current command
 */
export async function getDryRunContext<P extends ContextSettings>({
  registryUri,
  configOverrideUri,
  chains,
  keyConfig,
  skipConfirmation,
}: P): Promise<CommandContext<P>> {
  const registry = getRegistry(registryUri, configOverrideUri);
  const chainMetadata = await registry.getMetadata();

  if (!chains?.length) {
    if (skipConfirmation) throw new Error('No chains provided');
    chains = [
      await runSingleChainSelectionStep(
        chainMetadata,
        'Select chain to dry-run against:',
      ),
    ];
  }

  const multiProvider = await getMultiProvider(registry);
  await forkNetworkToMultiProvider(multiProvider, chains[0]);
  const impersonatedSigner = await getImpersonatedSigner({
    keyConfig,
    skipConfirmation,
  });
  if (impersonatedSigner) multiProvider.setSharedSigner(impersonatedSigner);

  return {
    chains: chains || objKeys(chainMetadata),
    registry,
    signer: impersonatedSigner,
    multiProvider: multiProvider,
  } as CommandContext<P>;
}

function getRegistry(
  primaryRegistryUri?: string,
  overrideRegistryUri?: string,
): IRegistry {
  return new MergedRegistry({ primaryRegistryUri, overrideRegistryUri });
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
