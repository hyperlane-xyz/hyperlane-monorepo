import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';
import type { ArgumentsCamelCase, MiddlewareFunction } from 'yargs';

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
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { isSignCommand } from '../commands/signCommands.js';
import { readChainSubmissionStrategyConfig } from '../config/strategy.js';
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
  WriteCommandContext,
} from './types.js';

type UntypedOptions = Record<string, any>;
type UntypedArgv = ArgumentsCamelCase<UntypedOptions>;
type ArgvWithContext = UntypedArgv & { context: CommandContext };
type ArgvWithWriteContext = UntypedArgv & { context: WriteCommandContext };

export const contextMiddleware: MiddlewareFunction<UntypedOptions> = async (
  argv,
) => {
  const requiresKey = isSignCommand(argv);

  const settings: ContextSettings = {
    registryUris: [...argv.registry],
    key: argv.key,
    requiresKey,
    disableProxy: argv.disableProxy,
    skipConfirmation: argv.yes,
    strategyPath: argv.strategy,
    authToken: argv.authToken,
  };

  const context = await getContext(settings);
  setCommandContext(argv, context);
};

export const signerMiddleware: MiddlewareFunction<UntypedOptions> = async (
  argv,
) => {
  assertHasContext(argv);

  const chains = await resolveChains(argv);

  if (!argv.context.requiresKey) return;

  const writeContext = await getSignerContext(argv.context, argv, chains);
  setWriteCommandContext(argv, writeContext);
};

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

  const { keyMap, ethereumSignerAddress } = await getSignerKeyMap(
    key,
    !!skipConfirmation,
  );

  const multiProvider = await getMultiProvider(registry);
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

export async function getSignerContext(
  context: CommandContext,
  argv: UntypedArgv,
  preResolvedChains?: ChainName[],
): Promise<WriteCommandContext> {
  if (!context.key) {
    throw new Error(
      'Commands that modify on-chain state require a signing key. Provide one with --key.<protocol> or the HYP_KEY_<PROTOCOL> env var.',
    );
  }

  const strategyConfig = context.strategyPath
    ? await readChainSubmissionStrategyConfig(context.strategyPath)
    : {};

  const chains = preResolvedChains ?? (await resolveChains(argv));

  const altVmChains = chains.filter(
    (chain) =>
      context.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum,
  );

  await ensureAltVmProviders(context, altVmChains);

  const multiProtocolSigner = await MultiProtocolSignerManager.init(
    strategyConfig,
    chains,
    context.multiProtocolProvider,
    { key: context.key },
  );

  const multiProvider = await multiProtocolSigner.getMultiProvider();
  const altVmSigners = await createAltVMSigners(
    multiProvider,
    chains,
    context.key,
    strategyConfig,
  );

  const defaultEvmChain = chains.find(
    (chain) =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );
  const signer = defaultEvmChain
    ? multiProvider.getSigner(defaultEvmChain)
    : undefined;

  return {
    ...context,
    key: context.key,
    multiProvider,
    altVmSigners,
    signer,
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
 * @param customChains Custom chains specified by the user
 * @returns a new MultiProvider
 */
async function getMultiProvider(registry: IRegistry, signer?: ethers.Signer) {
  const chainMetadata = await registry.getMetadata();
  const multiProvider = new MultiProvider(chainMetadata);
  if (signer) multiProvider.setSharedSigner(signer);
  return multiProvider;
}

async function getMultiProtocolProvider(registry: IRegistry) {
  const chainMetadata = await registry.getMetadata();
  return new MultiProtocolProvider(chainMetadata);
}

function setCommandContext(
  argv: UntypedArgv,
  context: CommandContext,
): asserts argv is ArgvWithContext {
  (argv as ArgvWithContext).context = context;
}

function setWriteCommandContext(
  argv: ArgvWithContext,
  context: WriteCommandContext,
): asserts argv is ArgvWithWriteContext {
  (argv as ArgvWithWriteContext).context = context;
}

function assertHasContext(argv: UntypedArgv): asserts argv is ArgvWithContext {
  if (!argv.context) {
    throw new Error(
      'Command context is missing. Ensure contextMiddleware runs before signerMiddleware.',
    );
  }
}

async function ensureAltVmProviders(
  context: CommandContext,
  altVmChains: ChainName[],
) {
  if (!altVmChains.length) return;

  try {
    await loadProtocolProviders(
      new Set(
        altVmChains.map((chain) => context.multiProvider.getProtocol(chain)),
      ),
    );
  } catch (error) {
    throw new Error(
      `Failed to load providers in context for ${altVmChains.join(', ')}`,
      {
        cause: error,
      },
    );
  }

  await Promise.all(
    altVmChains.map(async (chain) => {
      const protocol = context.multiProvider.getProtocol(chain);
      const metadata = context.multiProvider.getChainMetadata(chain);

      if (!hasProtocol(protocol)) return;

      context.altVmProviders[chain] =
        await getProtocolProvider(protocol).createProvider(metadata);
    }),
  );
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
