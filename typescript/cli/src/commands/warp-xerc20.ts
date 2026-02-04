import { stringify as yamlStringify } from 'yaml';
import { type CommandModule } from 'yargs';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
  EvmXERC20Module,
  type WarpCoreConfig,
  type WarpRouteDeployConfigMailboxRequired,
  type XERC20Limits,
  type XERC20LimitsMap,
  isXERC20TokenConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, objFilter } from '@hyperlane-xyz/utils';

import {
  type CommandContext,
  type CommandModuleWithContext,
} from '../context/types.js';
import { log, logBlue, logCommandHeader, logGreen, logRed } from '../logger.js';
import { indentYamlOrJson, writeYamlOrJson } from '../utils/files.js';
import { getWarpConfigs } from '../utils/warp.js';

import {
  addressCommandOption,
  chainCommandOption,
  outputFileCommandOption,
  symbolCommandOption,
  warpCoreConfigCommandOption,
  warpDeploymentConfigCommandOption,
  warpRouteIdCommandOption,
} from './options.js';

const DEFAULT_OUTPUT_PATH = './xerc20-txs.yaml';

const XERC20_WARP_ROUTE_BUILDER = {
  config: warpDeploymentConfigCommandOption,
  warpRouteId: {
    ...warpRouteIdCommandOption,
    demandOption: false,
  },
  warp: {
    ...warpCoreConfigCommandOption,
    demandOption: false,
  },
  symbol: {
    ...symbolCommandOption,
    demandOption: false,
  },
} as const;

type XERC20WarpRouteBuilder = Partial<
  Record<keyof typeof XERC20_WARP_ROUTE_BUILDER, string>
>;

export const xerc20Command: CommandModule = {
  command: 'xerc20',
  describe: 'Manage XERC20 mint/burn limits and bridges',
  builder: (yargs) =>
    yargs
      .command(setLimits)
      .command(addBridge)
      .command(removeBridge)
      .command(viewLimits)
      .version(false)
      .demandCommand(),
  handler: () => log('Subcommand required'),
};

const setLimits: CommandModuleWithContext<
  XERC20WarpRouteBuilder & {
    bridge: string;
    mint?: string;
    burn?: string;
    bufferCap?: string;
    rateLimit?: string;
    chain?: string;
    out: string;
  }
> = {
  command: 'set-limits',
  describe: 'Set mint/burn limits for a bridge on XERC20 tokens',
  builder: {
    ...XERC20_WARP_ROUTE_BUILDER,
    bridge: addressCommandOption('Bridge address to set limits for', true),
    mint: {
      type: 'string',
      description: 'Mint limit (Standard XERC20)',
    },
    burn: {
      type: 'string',
      description: 'Burn limit (Standard XERC20)',
    },
    'buffer-cap': {
      type: 'string',
      description: 'Buffer cap (Velodrome XERC20)',
    },
    'rate-limit': {
      type: 'string',
      description: 'Rate limit per second (Velodrome XERC20)',
    },
    chain: {
      ...chainCommandOption,
      demandOption: false,
      description: 'Filter to specific chain(s)',
    },
    out: outputFileCommandOption(
      DEFAULT_OUTPUT_PATH,
      false,
      'Output transaction file path',
    ),
  },
  handler: async ({
    context,
    symbol,
    warp,
    warpRouteId,
    config: configPath,
    bridge,
    mint,
    burn,
    bufferCap,
    rateLimit,
    chain,
    out,
  }) => {
    const limits = parseLimitsFromArgs({ mint, burn, bufferCap, rateLimit });
    await generateBridgeLimitTxs({
      context,
      symbol,
      warp,
      warpRouteId,
      configPath,
      bridge,
      limits,
      chain,
      out,
      commandName: 'Set Limits',
      txGenerator: (module, bridgeAddr, lim) =>
        module.generateSetLimitsTxs(bridgeAddr, lim),
    });
  },
};

const addBridge: CommandModuleWithContext<
  XERC20WarpRouteBuilder & {
    bridge: string;
    mint?: string;
    burn?: string;
    bufferCap?: string;
    rateLimit?: string;
    chain?: string;
    out: string;
  }
> = {
  command: 'add-bridge',
  describe: 'Add a new bridge with limits to XERC20 tokens',
  builder: {
    ...XERC20_WARP_ROUTE_BUILDER,
    bridge: addressCommandOption('Bridge address to add', true),
    mint: {
      type: 'string',
      description: 'Mint limit (Standard XERC20)',
    },
    burn: {
      type: 'string',
      description: 'Burn limit (Standard XERC20)',
    },
    'buffer-cap': {
      type: 'string',
      description: 'Buffer cap (Velodrome XERC20)',
    },
    'rate-limit': {
      type: 'string',
      description: 'Rate limit per second (Velodrome XERC20)',
    },
    chain: {
      ...chainCommandOption,
      demandOption: false,
      description: 'Filter to specific chain(s)',
    },
    out: outputFileCommandOption(
      DEFAULT_OUTPUT_PATH,
      false,
      'Output transaction file path',
    ),
  },
  handler: async ({
    context,
    symbol,
    warp,
    warpRouteId,
    config: configPath,
    bridge,
    mint,
    burn,
    bufferCap,
    rateLimit,
    chain,
    out,
  }) => {
    const limits = parseLimitsFromArgs({ mint, burn, bufferCap, rateLimit });
    await generateBridgeLimitTxs({
      context,
      symbol,
      warp,
      warpRouteId,
      configPath,
      bridge,
      limits,
      chain,
      out,
      commandName: 'Add Bridge',
      txGenerator: (module, bridgeAddr, lim) =>
        module.generateAddBridgeTxs(bridgeAddr, lim),
    });
  },
};

const removeBridge: CommandModuleWithContext<
  XERC20WarpRouteBuilder & {
    bridge: string;
    chain?: string;
    out: string;
  }
> = {
  command: 'remove-bridge',
  describe: 'Remove a bridge from Velodrome XERC20 tokens (Velodrome only)',
  builder: {
    ...XERC20_WARP_ROUTE_BUILDER,
    bridge: addressCommandOption('Bridge address to remove', true),
    chain: {
      ...chainCommandOption,
      demandOption: false,
      description: 'Filter to specific chain(s)',
    },
    out: outputFileCommandOption(
      DEFAULT_OUTPUT_PATH,
      false,
      'Output transaction file path',
    ),
  },
  handler: async ({
    context,
    symbol,
    warp,
    warpRouteId,
    config: configPath,
    bridge,
    chain,
    out,
  }) => {
    logCommandHeader('Hyperlane XERC20 Remove Bridge');

    const { warpDeployConfig, warpCoreConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: configPath,
      warpCoreConfigPath: warp,
    });

    const filteredConfig = filterConfigByChain(warpDeployConfig, chain);
    const transactions: AnnotatedEV5Transaction[] = [];

    for (const chainName of Object.keys(filteredConfig)) {
      const chainConfig = filteredConfig[chainName];
      if (!isXERC20TokenConfig(chainConfig)) {
        logRed(`Skipping ${chainName}: not an XERC20 config`);
        continue;
      }

      logBlue(`Generating remove-bridge transactions for ${chainName}...`);
      try {
        const warpRouteAddress = getWarpRouteAddress(warpCoreConfig, chainName);
        const { module } = await EvmXERC20Module.fromWarpRouteConfig(
          context.multiProvider,
          chainName,
          chainConfig,
          warpRouteAddress,
        );
        const txs = await module.generateRemoveBridgeTxs(bridge);
        transactions.push(...txs);
      } catch (error) {
        logRed(`Failed for ${chainName}: ${error}`);
        logRed('Note: remove-bridge is only supported for Velodrome XERC20.');
      }
    }

    if (transactions.length === 0) {
      logRed(
        'No transactions generated. Ensure the chains have Velodrome XERC20 configs.',
      );
      process.exit(1);
    }

    writeYamlOrJson(out, transactions, 'yaml');
    logGreen(
      `\n✅ Generated ${transactions.length} transaction(s) written to ${out}`,
    );
    log(indentYamlOrJson(yamlStringify(transactions, null, 2), 4));

    process.exit(0);
  },
};

const viewLimits: CommandModuleWithContext<
  XERC20WarpRouteBuilder & {
    chain?: string;
  }
> = {
  command: 'view-limits',
  describe: 'View current XERC20 limits for all bridges',
  builder: {
    ...XERC20_WARP_ROUTE_BUILDER,
    chain: {
      ...chainCommandOption,
      demandOption: false,
      description: 'Filter to specific chain(s)',
    },
  },
  handler: async ({
    context,
    symbol,
    warp,
    warpRouteId,
    config: configPath,
    chain,
  }) => {
    logCommandHeader('Hyperlane XERC20 View Limits');

    const { warpDeployConfig, warpCoreConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: configPath,
      warpCoreConfigPath: warp,
    });

    const filteredConfig = filterConfigByChain(warpDeployConfig, chain);
    const allLimits: Record<string, { type: string; limits: XERC20LimitsMap }> =
      {};

    for (const chainName of Object.keys(filteredConfig)) {
      const chainConfig = filteredConfig[chainName];
      if (!isXERC20TokenConfig(chainConfig)) {
        logRed(`Skipping ${chainName}: not an XERC20 config`);
        continue;
      }

      logBlue(`Reading limits for ${chainName}...`);
      try {
        const warpRouteAddress = getWarpRouteAddress(warpCoreConfig, chainName);
        const { module, config } = await EvmXERC20Module.fromWarpRouteConfig(
          context.multiProvider,
          chainName,
          chainConfig,
          warpRouteAddress,
        );

        const onChainConfig = await module.read();
        const onChainBridges = Object.keys(onChainConfig.limits);
        const expectedBridges = Object.keys(config.limits);
        const allBridges = [
          ...new Set([...onChainBridges, ...expectedBridges]),
        ];

        const { xERC20 } = module.serialize();
        const limits = await module.reader.readLimits(
          xERC20,
          allBridges,
          onChainConfig.type,
        );

        allLimits[chainName] = {
          type: onChainConfig.type,
          limits,
        };
      } catch (error) {
        logRed(`Failed to read limits for ${chainName}: ${error}`);
      }
    }

    logGreen('\n✅ XERC20 Limits:');
    log(indentYamlOrJson(yamlStringify(allLimits, null, 2), 4));

    process.exit(0);
  },
};

function getWarpRouteAddress(
  warpCoreConfig: WarpCoreConfig,
  chain: ChainName,
): Address {
  const token = warpCoreConfig.tokens.find((t) => t.chainName === chain);
  assert(
    token?.addressOrDenom,
    `Missing warp route address for chain ${chain} in warpCoreConfig`,
  );
  return token.addressOrDenom;
}

function parseLimitsFromArgs(args: {
  mint?: string;
  burn?: string;
  bufferCap?: string;
  rateLimit?: string;
}): XERC20Limits {
  const hasStandardLimits = args.mint !== undefined || args.burn !== undefined;
  const hasVelodromeLimits =
    args.bufferCap !== undefined || args.rateLimit !== undefined;

  assert(
    hasStandardLimits !== hasVelodromeLimits,
    'Provide either --mint/--burn (Standard) OR --buffer-cap/--rate-limit (Velodrome), not both',
  );

  if (hasStandardLimits) {
    assert(args.mint !== undefined, '--mint is required for Standard XERC20');
    assert(args.burn !== undefined, '--burn is required for Standard XERC20');
    return {
      type: 'standard',
      mint: args.mint,
      burn: args.burn,
    };
  }

  assert(
    args.bufferCap !== undefined,
    '--buffer-cap is required for Velodrome XERC20',
  );
  assert(
    args.rateLimit !== undefined,
    '--rate-limit is required for Velodrome XERC20',
  );
  return {
    type: 'velodrome',
    bufferCap: args.bufferCap,
    rateLimitPerSecond: args.rateLimit,
  };
}

async function generateBridgeLimitTxs({
  context,
  symbol,
  warp,
  warpRouteId,
  configPath,
  bridge,
  limits,
  chain,
  out,
  commandName,
  txGenerator,
}: {
  context: CommandContext;
  symbol?: string;
  warp?: string;
  warpRouteId?: string;
  configPath?: string;
  bridge: Address;
  limits: XERC20Limits;
  chain?: string;
  out: string;
  commandName: string;
  txGenerator: (
    module: EvmXERC20Module,
    bridge: Address,
    limits: XERC20Limits,
  ) => Promise<AnnotatedEV5Transaction[]>;
}): Promise<void> {
  logCommandHeader(`Hyperlane XERC20 ${commandName}`);

  const { warpDeployConfig, warpCoreConfig } = await getWarpConfigs({
    context,
    warpRouteId,
    symbol,
    warpDeployConfigPath: configPath,
    warpCoreConfigPath: warp,
  });

  const filteredConfig = filterConfigByChain(warpDeployConfig, chain);
  const transactions: AnnotatedEV5Transaction[] = [];

  for (const chainName of Object.keys(filteredConfig)) {
    const chainConfig = filteredConfig[chainName];
    if (!isXERC20TokenConfig(chainConfig)) {
      logRed(`Skipping ${chainName}: not an XERC20 config`);
      continue;
    }

    logBlue(
      `Generating ${commandName.toLowerCase()} transactions for ${chainName}...`,
    );

    const warpRouteAddress = getWarpRouteAddress(warpCoreConfig, chainName);
    const { module } = await EvmXERC20Module.fromWarpRouteConfig(
      context.multiProvider,
      chainName,
      chainConfig,
      warpRouteAddress,
    );

    const txs = await txGenerator(module, bridge, limits);
    transactions.push(...txs);
  }

  if (transactions.length === 0) {
    logRed(
      'No transactions generated. Check that the chains have XERC20 configs.',
    );
    process.exit(1);
  }

  writeYamlOrJson(out, transactions, 'yaml');
  logGreen(
    `\n✅ Generated ${transactions.length} transaction(s) written to ${out}`,
  );
  log(indentYamlOrJson(yamlStringify(transactions, null, 2), 4));

  process.exit(0);
}

function filterConfigByChain(
  config: WarpRouteDeployConfigMailboxRequired,
  chain?: string,
): WarpRouteDeployConfigMailboxRequired {
  if (!chain) return config;

  const chainNames = chain.split(',').map((c) => c.trim());
  return objFilter(
    config,
    (
      chainName,
      chainConfig,
    ): chainConfig is WarpRouteDeployConfigMailboxRequired[string] =>
      chainNames.includes(chainName),
  );
}
