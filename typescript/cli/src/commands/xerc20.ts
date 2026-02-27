import { groupBy } from 'lodash-es';
import { stringify as yamlStringify } from 'yaml';
import { type CommandModule } from 'yargs';

import {
  type AnnotatedEvmTransaction,
  type ChainName,
  EvmXERC20Module,
  type WarpCoreConfig,
  type WarpRouteDeployConfigMailboxRequired,
  type XERC20LimitsMap,
  isXERC20TokenConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, objFilter } from '@hyperlane-xyz/utils';

import { runSubmit } from '../config/submit.js';
import {
  type CommandModuleWithContext,
  type CommandModuleWithWriteContext,
  type WriteCommandContext,
} from '../context/types.js';
import {
  log,
  logBlue,
  logCommandHeader,
  logGray,
  logGreen,
  logRed,
} from '../logger.js';
import { indentYamlOrJson, isFile } from '../utils/files.js';
import { getWarpConfigs } from '../utils/warp.js';

import {
  chainTargetsCommandOption,
  outputFileCommandOption,
  strategyCommandOption,
  symbolCommandOption,
  warpCoreConfigCommandOption,
  warpDeploymentConfigCommandOption,
  warpRouteIdCommandOption,
} from './options.js';

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
    yargs.command(apply).command(read).version(false).demandCommand(),
  handler: () => log('Subcommand required'),
};

const apply: CommandModuleWithWriteContext<
  XERC20WarpRouteBuilder & {
    chains?: string[];
    strategy?: string;
    receipts: string;
  }
> = {
  command: 'apply',
  describe:
    'Apply XERC20 config from warp deploy config (auto-detects add/update/remove)',
  builder: {
    ...XERC20_WARP_ROUTE_BUILDER,
    chains: {
      ...chainTargetsCommandOption,
      demandOption: false,
      description: 'Filter to specific chain(s)',
    },
    strategy: { ...strategyCommandOption, demandOption: false },
    receipts: outputFileCommandOption(
      './generated/transactions/receipts',
      false,
      'Output directory for transaction receipts',
    ),
  },
  handler: async ({
    context,
    symbol,
    warp,
    warpRouteId,
    config: configPath,
    chains,
    strategy,
    receipts,
  }) => {
    logCommandHeader('Hyperlane XERC20 Apply');

    const { warpDeployConfig, warpCoreConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: configPath,
      warpCoreConfigPath: warp,
    });

    const filteredConfig = filterConfigByChain(warpDeployConfig, chains);
    const transactions: AnnotatedEvmTransaction[] = [];

    for (const chainName of Object.keys(filteredConfig)) {
      const chainConfig = filteredConfig[chainName];
      if (!isXERC20TokenConfig(chainConfig)) {
        logGray(`Skipping ${chainName}: not an XERC20 config`);
        continue;
      }

      logBlue(`Checking XERC20 config for ${chainName}...`);
      try {
        const warpRouteAddress = getWarpRouteAddress(warpCoreConfig, chainName);
        const { module, config: expectedConfig } =
          await EvmXERC20Module.fromWarpRouteConfig(
            context.multiProvider,
            chainName,
            chainConfig,
            warpRouteAddress,
          );

        const txs = await module.update(expectedConfig);
        if (txs.length > 0) {
          logBlue(`Generated ${txs.length} transaction(s) for ${chainName}`);
          transactions.push(...txs);
        } else {
          logGreen(
            `${chainName}: XERC20 config already matches on-chain state`,
          );
        }
      } catch (error) {
        logRed(`Failed for ${chainName}: ${error}`);
      }
    }

    if (transactions.length === 0) {
      logGreen(
        '✅ All XERC20 configs match on-chain state. No updates needed.',
      );
      process.exit(0);
    }

    await submitTransactions(context, transactions, strategy, receipts);
    logGreen('✅ Successfully applied XERC20 config changes');
    process.exit(0);
  },
};

const read: CommandModuleWithContext<
  XERC20WarpRouteBuilder & {
    chains?: string[];
  }
> = {
  command: 'read',
  describe: 'Read current XERC20 limits for all bridges',
  builder: {
    ...XERC20_WARP_ROUTE_BUILDER,
    chains: {
      ...chainTargetsCommandOption,
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
    chains,
  }) => {
    logCommandHeader('Hyperlane XERC20 Read');

    const { warpDeployConfig, warpCoreConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: configPath,
      warpCoreConfigPath: warp,
    });

    const filteredConfig = filterConfigByChain(warpDeployConfig, chains);
    const allLimits: Record<string, { type: string; limits: XERC20LimitsMap }> =
      {};

    for (const chainName of Object.keys(filteredConfig)) {
      const chainConfig = filteredConfig[chainName];
      if (!isXERC20TokenConfig(chainConfig)) {
        logGray(`Skipping ${chainName}: not an XERC20 config`);
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

async function submitTransactions(
  context: WriteCommandContext,
  transactions: AnnotatedEvmTransaction[],
  strategy: string | undefined,
  receipts: string,
): Promise<void> {
  if (isFile(receipts)) {
    logRed(
      `Error: receipts path '${receipts}' exists but is a file. Expected a directory.`,
    );
    process.exit(1);
  }

  const chainTransactions = groupBy(transactions, 'chainId');

  for (const [chainId, txs] of Object.entries(chainTransactions)) {
    const chain = context.multiProvider.getChainName(chainId);

    await runSubmit({
      context,
      chain,
      transactions: txs,
      strategyPath: strategy,
      receiptsFilepath: receipts,
    });
    logBlue(`Submission complete for chain ${chain}`);
  }
}

function filterConfigByChain(
  config: WarpRouteDeployConfigMailboxRequired,
  chains?: string[],
): WarpRouteDeployConfigMailboxRequired {
  if (!chains || chains.length === 0) return config;

  return objFilter(
    config,
    (
      chainName,
      chainConfig,
    ): chainConfig is WarpRouteDeployConfigMailboxRequired[string] =>
      chains.includes(chainName),
  );
}
