import { confirm } from '@inquirer/prompts';
import { type ethers } from 'ethers';

import { loadProtocolProviders } from '@hyperlane-xyz/deploy-sdk';
import {
  type AltVM,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { type IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  type ChainMap,
  type ChainMetadata,
  type ChainName,
  ExplorerFamily,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { isSignCommand } from '../commands/signCommands.js';
import { readChainSubmissionStrategyConfig } from '../config/strategy.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';
import { getSigner } from '../utils/keys.js';

import { createAltVMSigners } from './altvm.js';
import { resolveChains } from './strategies/chain/chainResolver.js';
import { MultiProtocolSignerManager } from './strategies/signer/MultiProtocolSignerManager.js';
import {
  type CommandContext,
  type ContextSettings,
  type SignerKeyProtocolMap,
  SignerKeyProtocolMapSchema,
} from './types.js';

type ContextMiddlewareArgv = Record<string, unknown> & {
  context?: CommandContext;
};

function hasIterator(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    Symbol.iterator in value
  );
}

function parseRegistryUris(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];

  const values = Array.isArray(value)
    ? value
    : hasIterator(value)
      ? Array.from(value)
      : null;

  assert(
    values !== null,
    `Invalid --registry value type: expected string or iterable of strings, got ${typeof value}`,
  );
  assert(
    values.every((entry) => typeof entry === 'string'),
    'Invalid --registry value: expected only string entries',
  );

  return values;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toOptionalSignerKey(value: unknown): ContextSettings['key'] {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  const parsed = SignerKeyProtocolMapSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function contextMiddleware(argv: ContextMiddlewareArgv) {
  const requiresKey = isSignCommand(argv);

  const settings: ContextSettings = {
    registryUris: parseRegistryUris(argv.registry),
    key: toOptionalSignerKey(argv.key),
    requiresKey,
    disableProxy: toOptionalBoolean(argv.disableProxy),
    skipConfirmation: toOptionalBoolean(argv.yes),
    strategyPath: toOptionalString(argv.strategy),
    authToken: toOptionalString(argv.authToken),
  };

  argv.context = await getContext(settings);
}

function hasCommandContext(
  argv: ContextMiddlewareArgv,
): argv is ContextMiddlewareArgv & { context: CommandContext } {
  return typeof argv.context === 'object' && argv.context !== null;
}

export async function signerMiddleware(argv: ContextMiddlewareArgv) {
  assert(
    hasCommandContext(argv),
    'Expected command context in signerMiddleware',
  );
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

  if (!requiresKey) return;
  assert(key, 'Expected signer keys when running signer middleware');

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

  return;
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
    ProtocolType.Aleo,
    ProtocolType.Starknet,
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

/**
 * Ensures EVM signers are attached to multiProvider for the specified chains.
 * This is useful for commands that do interactive chain selection after the
 * initial signer middleware has run.
 *
 * Uses the same signer strategy infrastructure as the middleware, which properly
 * handles ZkSync chains and strategy-based keys.
 *
 * @param context - The write command context with key, multiProvider, and multiProtocolProvider
 * @param chains - The chains to ensure signers for
 */
export async function ensureEvmSignersForChains(
  context: {
    key: SignerKeyProtocolMap;
    multiProvider: MultiProvider;
    multiProtocolProvider: MultiProtocolProvider;
    strategyPath?: string;
  },
  chains: ChainName[],
): Promise<void> {
  // Filter to only EVM chains
  const evmChains = chains.filter(
    (chain) =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );

  // Find chains that are missing signers
  const missingSignerChains = evmChains.filter(
    (chain) => !context.multiProvider.tryGetSigner(chain),
  );

  // If all signers already exist, nothing to do
  if (missingSignerChains.length === 0) {
    return;
  }

  // Load strategy config if provided
  const strategyConfig = context.strategyPath
    ? await readChainSubmissionStrategyConfig(context.strategyPath)
    : {};

  // Use MultiProtocolSignerManager to create signers properly
  // This handles ZkSync chains and strategy-based keys
  const signerManager = await MultiProtocolSignerManager.init(
    strategyConfig,
    missingSignerChains,
    context.multiProtocolProvider,
    { key: context.key },
  );

  // Attach the created signers to multiProvider
  for (const chain of missingSignerChains) {
    const signer = signerManager.getEVMSigner(chain);
    const provider = context.multiProvider.getProvider(chain);
    context.multiProvider.setSigner(chain, signer.connect(provider));
  }
}
