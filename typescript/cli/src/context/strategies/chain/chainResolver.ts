import { RebalancerConfig } from '@hyperlane-xyz/rebalancer';
import {
  type ChainName,
  type DeployedCoreAddresses,
  DeployedCoreAddressesSchema,
  EvmCoreModule,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { CommandType } from '../../../commands/signCommands.js';
import { readCoreDeployConfigs } from '../../../config/core.js';
import { getWarpRouteDeployConfig } from '../../../config/warp.js';
import {
  filterOutDisabledChains,
  runSingleChainSelectionStep,
} from '../../../utils/chains.js';
import {
  getWarpConfigs,
  getWarpCoreConfigOrExit,
} from '../../../utils/warp.js';
import { requestAndSaveApiKeys } from '../../context.js';

/**
 * Resolves chains based on command type.
 * @param argv - Command line arguments.
 * @returns Promise<ChainName[]> - The chains resolved based on the command type.
 */
export async function resolveChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  const commandKey = `${argv._[0]}:${argv._[1] || ''}`.trim() as CommandType;

  switch (commandKey) {
    case CommandType.WARP_DEPLOY:
      return resolveWarpRouteConfigChains(argv);
    case CommandType.SEND_MESSAGE:
      return resolveSendMessageChains(argv);
    case CommandType.WARP_SEND:
    case CommandType.STATUS:
    case CommandType.RELAYER:
      return resolveRelayerChains(argv);
    case CommandType.WARP_READ:
      return resolveWarpReadChains(argv);
    case CommandType.WARP_APPLY:
    case CommandType.WARP_CHECK:
      return resolveWarpConfigChains(argv);
    case CommandType.WARP_REBALANCER:
      return resolveWarpRebalancerChains(argv);

    case CommandType.SUBMIT:
      return resolveWarpRouteConfigChains(argv); // Same as WARP_DEPLOY
    case CommandType.CORE_APPLY:
      return resolveCoreApplyChains(argv);
    case CommandType.CORE_DEPLOY:
      return resolveCoreDeployChains(argv);
    case CommandType.CORE_READ:
    case CommandType.CORE_CHECK:
      return resolveChain(argv);
    case CommandType.ICA_DEPLOY:
      return resolveIcaDeployChains(argv);
    default:
      return resolveRelayerChains(argv);
  }
}

async function resolveWarpRouteConfigChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  const warpDeployConfig = await getWarpRouteDeployConfig({
    context: argv.context,
    warpRouteDeployConfigPath: argv.config,
    warpRouteId: argv.warpRouteId,
    symbol: argv.symbol,
  });
  argv.context.warpDeployConfig = warpDeployConfig;
  argv.context.chains = Object.keys(warpDeployConfig);
  assert(
    argv.context.chains.length !== 0,
    'No chains found in warp route deployment config',
  );
  return argv.context.chains;
}

async function resolveWarpReadChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  if (argv.chain) {
    argv.context.chains = await resolveChain(argv);
  }

  if (argv.symbol || argv.warpRouteId) {
    const warpCoreConfig = await getWarpCoreConfigOrExit({
      context: argv.context,
      symbol: argv.symbol,
      warpRouteId: argv.warpRouteId,
    });
    argv.context.chains = warpCoreConfig.tokens.map((token) => token.chainName);
  }

  assert(
    argv.context.chains && argv.context.chains.length !== 0,
    'No chains found set in parameters',
  );

  return argv.context.chains;
}

async function resolveChain(argv: Record<string, any>): Promise<ChainName[]> {
  const chains = argv.chain ? [argv.chain] : [];
  assert(chains.length !== 0, 'No chains found set in parameters');
  return chains;
}

async function resolveWarpConfigChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  const { warpCoreConfig, warpDeployConfig } = await getWarpConfigs({
    context: argv.context,
    warpRouteId: argv.warpRouteId,
    symbol: argv.symbol,
    warpDeployConfigPath: argv.config,
    warpCoreConfigPath: argv.warp,
  });
  argv.context.warpCoreConfig = warpCoreConfig;
  argv.context.warpDeployConfig = warpDeployConfig;
  argv.context.chains = Object.keys(warpDeployConfig);

  assert(
    argv.context.chains.length !== 0,
    'No chains found in warp route deployment config',
  );
  return argv.context.chains;
}

async function resolveWarpRebalancerChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  // Load rebalancer config to get the configured chains
  const rebalancerConfig = RebalancerConfig.load(argv.config);

  // Extract chain names from the rebalancer config's strategy.chains
  // This ensures we only create signers for chains we can actually rebalance
  const chains = Object.keys(rebalancerConfig.strategyConfig.chains);

  assert(chains.length !== 0, 'No chains configured in rebalancer config');

  return chains;
}

/**
 * Resolves chains for the 'send message' command.
 * Returns only explicitly provided chains (origin/destination).
 * If either is missing, returns only the provided ones - signers for
 * interactively selected chains will be created after selection.
 */
async function resolveSendMessageChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  const { multiProvider } = argv.context;
  const selectedChains = [argv.origin, argv.destination].filter(
    Boolean,
  ) as ChainName[];

  if (selectedChains.length > 0) {
    const nonEvmChains = selectedChains.filter(
      (chain) => multiProvider.getProtocol(chain) !== ProtocolType.Ethereum,
    );
    if (nonEvmChains.length > 0) {
      const chainDetails = nonEvmChains
        .map((chain) => `'${chain}' (${multiProvider.getProtocol(chain)})`)
        .join(', ');
      throw new Error(
        `'hyperlane send message' only supports EVM chains. Non-EVM chains found: ${chainDetails}`,
      );
    }
  }

  // Return only explicitly provided chains - signers for interactively
  // selected chains will be created after selection
  return selectedChains;
}

async function resolveRelayerChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  const { multiProvider, chainMetadata } = argv.context;
  const chains = new Set<ChainName>();

  if (argv.origin) {
    chains.add(argv.origin);
  }

  if (argv.chain) {
    chains.add(argv.chain);
  }

  if (argv.chains?.length) {
    return Array.from(new Set([...chains, ...argv.chains]));
  }

  // If no destination is specified, return all EVM chains only
  if (!argv.destination) {
    const chains = Object.keys(filterOutDisabledChains(chainMetadata));

    return chains.filter(
      (chain: string) =>
        ProtocolType.Ethereum === multiProvider.getProtocol(chain),
    );
  }

  chains.add(argv.destination);
  return Array.from(chains);
}

async function resolveCoreApplyChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  try {
    const config = readCoreDeployConfigs(argv.config);

    if (!config?.interchainAccountRouter) {
      return [argv.chain];
    }

    const addresses = await argv.context.registry.getChainAddresses(argv.chain);
    const coreAddresses = DeployedCoreAddressesSchema.parse(
      addresses,
    ) as DeployedCoreAddresses;

    const protocolType = argv.context.multiProvider.getProtocol(argv.chain);

    switch (protocolType) {
      case ProtocolType.Ethereum: {
        const evmCoreModule = new EvmCoreModule(argv.context.multiProvider, {
          chain: argv.chain,
          config,
          addresses: coreAddresses,
        });

        const transactions = await evmCoreModule.update(config);

        return Array.from(new Set(transactions.map((tx) => tx.chainId))).map(
          (chainId) => argv.context.multiProvider.getChainName(chainId),
        );
      }
      default: {
        return [argv.chain];
      }
    }
  } catch (error) {
    throw new Error(`Failed to resolve core apply chains`, {
      cause: error,
    });
  }
}

async function resolveCoreDeployChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  try {
    const { chainMetadata, registry, skipConfirmation } = argv.context;

    let chain: string;

    if (argv.chain) {
      chain = argv.chain;
    } else {
      if (skipConfirmation) throw new Error('No chain provided');
      chain = await runSingleChainSelectionStep(
        chainMetadata,
        'Select chain to connect:',
      );
    }
    if (!skipConfirmation) {
      argv.context.apiKeys = await requestAndSaveApiKeys(
        [chain],
        chainMetadata,
        registry,
      );
    }

    argv.chain = chain;
    return [chain];
  } catch (error) {
    throw new Error(`Failed to resolve core deploy chains`, {
      cause: error,
    });
  }
}

async function resolveIcaDeployChains(
  argv: Record<string, any>,
): Promise<ChainName[]> {
  const chains = new Set<ChainName>();
  if (argv.origin) chains.add(argv.origin);
  if (argv.chains?.length) argv.chains.forEach((c: ChainName) => chains.add(c));
  assert(chains.size > 0, 'No chains provided for ICA deploy');
  return Array.from(chains);
}
