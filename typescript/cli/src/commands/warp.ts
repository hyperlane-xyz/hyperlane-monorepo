import util from 'util';
import { stringify as yamlStringify } from 'yaml';
import { type CommandModule } from 'yargs';

import { RebalancerConfig, RebalancerService } from '@hyperlane-xyz/rebalancer';
import {
  type RawForkedChainConfigByChain,
  RawForkedChainConfigByChainSchema,
  expandVirtualWarpDeployConfig,
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  difference,
  intersection,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { runWarpIcaOwnerCheck, runWarpRouteCheck } from '../check/warp.js';
import { createWarpRouteDeployConfig } from '../config/warp.js';
import {
  type CommandModuleWithContext,
  type CommandModuleWithWarpApplyContext,
  type CommandModuleWithWarpDeployContext,
  type CommandModuleWithWriteContext,
} from '../context/types.js';
import { runWarpRouteApply, runWarpRouteDeploy } from '../deploy/warp.js';
import { runForkCommand } from '../fork/fork.js';
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
} from '../logger.js';
import { getWarpRouteConfigsByCore, runWarpRouteRead } from '../read/warp.js';
import { sendTestTransfer } from '../send/transfer.js';
import { ExtendedChainSubmissionStrategySchema } from '../submitters/types.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  removeTrailingSlash,
  writeYamlOrJson,
} from '../utils/files.js';
import {
  filterWarpConfigsToMatchingChains,
  getWarpConfigs,
  getWarpCoreConfigOrExit,
} from '../utils/warp.js';
import { runVerifyWarpRoute } from '../verify/warp.js';

import {
  addressCommandOption,
  chainCommandOption,
  forkCommandOptions,
  outputFileCommandOption,
  strategyCommandOption,
  stringArrayOptionConfig,
  symbolCommandOption,
  warpCoreConfigCommandOption,
  warpDeploymentConfigCommandOption,
  warpRouteIdCommandOption,
} from './options.js';
import { type MessageOptionsArgTypes, messageSendOptions } from './send.js';

/**
 * Parent command
 */
export const warpCommand: CommandModule = {
  command: 'warp',
  describe: 'Manage Hyperlane warp routes',
  builder: (yargs) =>
    yargs
      .command(apply)
      .command(check)
      .command(deploy)
      .command(fork)
      .command(init)
      .command(read)
      .command(rebalancer)
      .command(send)
      .command(verify)
      .version(false)
      .demandCommand(),

  handler: () => log('Command required'),
};

const SELECT_WARP_ROUTE_BUILDER = {
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

type SelectWarpRouteBuilder = Partial<
  Record<keyof typeof SELECT_WARP_ROUTE_BUILDER, string>
>;

export const apply: CommandModuleWithWarpApplyContext<
  SelectWarpRouteBuilder & {
    strategy?: string;
    receiptsDir: string;
    relay?: boolean;
  }
> = {
  command: 'apply',
  describe: 'Update Warp Route contracts',
  builder: {
    ...SELECT_WARP_ROUTE_BUILDER,
    strategy: { ...strategyCommandOption, demandOption: false },
    'receipts-dir': {
      type: 'string',
      description: 'The directory to output transaction receipts.',
      default: './generated/transactions',
      coerce: (dir) => removeTrailingSlash(dir),
    },
    relay: {
      type: 'boolean',
      description:
        'Handle self-relay of ICA transactions when using a JSON RPC submitter',
      default: false,
    },
  },
  handler: async ({
    context,
    strategy: strategyUrl,
    receiptsDir,
    relay,
    warpRouteId,
  }) => {
    logCommandHeader('Hyperlane Warp Apply');

    if (strategyUrl)
      ExtendedChainSubmissionStrategySchema.parse(readYamlOrJson(strategyUrl));

    await runWarpRouteApply({
      context,
      // Already fetched in the resolveWarpApplyChains
      warpDeployConfig: context.warpDeployConfig,
      warpCoreConfig: context.warpCoreConfig,
      strategyUrl,
      receiptsDir,
      selfRelay: relay,
      warpRouteId,
    });
    process.exit(0);
  },
};

export const deploy: CommandModuleWithWarpDeployContext<SelectWarpRouteBuilder> =
  {
    command: 'deploy',
    describe: 'Deploy Warp Route contracts',
    builder: SELECT_WARP_ROUTE_BUILDER,
    handler: async ({ context, warpRouteId, config }) => {
      logCommandHeader(`Hyperlane Warp Route Deployment`);

      await runWarpRouteDeploy({
        context,
        // Already fetched in the resolveWarpRouteConfigChains
        warpDeployConfig: context.warpDeployConfig,
        warpRouteId,
        warpDeployConfigFileName: config,
      });

      process.exit(0);
    },
  };

export const init: CommandModuleWithContext<{
  advanced: boolean;
  out: string;
}> = {
  command: 'init',
  describe: 'Create a warp route configuration.',
  builder: {
    advanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM',
      default: false,
    },
    out: outputFileCommandOption(),
  },
  handler: async ({ context, advanced, out }) => {
    logCommandHeader('Hyperlane Warp Configure');

    await createWarpRouteDeployConfig({
      context,
      outPath: out,
      advanced,
    });
    process.exit(0);
  },
};

export const read: CommandModuleWithContext<
  SelectWarpRouteBuilder & {
    chain?: string;
    address?: string;
  }
> = {
  command: 'read',
  describe: 'Derive the warp route config from onchain artifacts',
  builder: {
    ...SELECT_WARP_ROUTE_BUILDER,
    chain: {
      ...chainCommandOption,
      demandOption: false,
    },
    address: addressCommandOption(
      'Address of the router contract to read.',
      false,
    ),
  },
  handler: async ({
    context,
    chain,
    address,
    config: configFilePath,
    symbol,
    warp,
    warpRouteId,
  }) => {
    logCommandHeader('Hyperlane Warp Reader');

    const config = await runWarpRouteRead({
      context,
      chain,
      address,
      symbol,
      warpCoreConfigPath: warp,
      warpRouteId,
    });

    if (configFilePath) {
      writeYamlOrJson(configFilePath, config, 'yaml');
      logGreen(
        `✅ Warp route config written successfully to ${configFilePath}:\n`,
      );
    } else {
      logGreen(`✅ Warp route config read successfully:\n`);
    }
    log(indentYamlOrJson(yamlStringify(config, null, 2), 4));
    process.exit(0);
  },
};

const send: CommandModuleWithWriteContext<
  MessageOptionsArgTypes &
    SelectWarpRouteBuilder & {
      router?: string;
      amount: string;
      recipient?: string;
      chains?: string[];
      skipValidation?: boolean;
    }
> = {
  command: 'send',
  describe: 'Send a test token transfer on a warp route',
  builder: {
    ...messageSendOptions,
    ...SELECT_WARP_ROUTE_BUILDER,
    amount: {
      type: 'string',
      description: 'Amount to send (in smallest unit)',
      default: 1,
    },
    recipient: {
      type: 'string',
      description: 'Token recipient address (defaults to sender)',
    },
    chains: stringArrayOptionConfig({
      description: 'List of chains to send messages to',
      demandOption: false,
      conflicts: ['origin', 'destination'],
    }),
    'skip-validation': {
      type: 'boolean',
      description: 'Skip transfer validation (e.g., collateral checks)',
      default: false,
    },
  },
  handler: async ({
    context,
    origin,
    destination,
    timeout,
    quick,
    relay,
    symbol,
    warp,
    amount,
    recipient,
    roundTrip,
    chains: chainsArg,
    skipValidation,
  }) => {
    const warpCoreConfig = await getWarpCoreConfigOrExit({
      symbol,
      warp,
      context,
    });
    let chains = chainsArg?.length ? chainsArg : [];

    if (origin && destination) {
      chains.push(origin);
      chains.push(destination);
    }

    const supportedChains = new Set(
      warpCoreConfig.tokens
        .map((t) => t.chainName)
        .sort((a, b) => a.localeCompare(b)),
    );

    // Check if any of the chain selection through --chains or --origin & --destination are not in the warp core
    const unsupportedChains = difference(
      new Set([...(chainsArg || []), origin, destination].filter(Boolean)),
      supportedChains,
    );
    assert(
      unsupportedChains.size === 0,
      `Chain(s) ${[...unsupportedChains].join(', ')} are not part of the warp route.`,
    );

    chains =
      chains.length === 0
        ? [...supportedChains]
        : [...intersection(new Set(chains), supportedChains)];

    if (roundTrip) {
      // Appends the reverse of the array, excluding the 1st (e.g. [1,2,3] becomes [1,2,3,2,1])
      const reversed = [...chains].reverse().slice(1, chains.length + 1);
      chains = [...chains, ...reversed];
    }

    logBlue(`🚀 Sending a message for chains: ${chains.join(' ➡️ ')}`);
    await sendTestTransfer({
      context,
      warpCoreConfig,
      chains,
      amount,
      recipient,
      timeoutSec: timeout,
      skipWaitForDelivery: quick,
      selfRelay: relay,
      skipValidation,
    });
    logGreen(
      `✅ Successfully sent messages for chains: ${chains.join(' ➡️ ')}`,
    );
    process.exit(0);
  },
};

export const check: CommandModuleWithContext<
  SelectWarpRouteBuilder & {
    ica?: boolean;
    origin?: string;
    originOwner?: string;
    chains?: string[];
  }
> = {
  command: 'check',
  describe:
    'Verifies that a warp route configuration matches the on chain configuration.',
  builder: {
    ...SELECT_WARP_ROUTE_BUILDER,
    ica: {
      type: 'boolean',
      description:
        'Check that destination chain owners match expected ICA addresses derived from origin chain owner',
      default: false,
    },
    origin: {
      type: 'string',
      description:
        'The origin chain to use for verification. Required when using --ica.',
      implies: 'ica',
    },
    originOwner: {
      type: 'string',
      description:
        'Override the origin owner address instead of reading from warp deploy config.',
      implies: 'origin',
    },
    chains: stringArrayOptionConfig({
      description:
        'List of chains to check. Defaults to all chains except origin when using --ica.',
      implies: 'ica',
    }),
  },
  handler: async ({
    context,
    symbol,
    warp,
    warpRouteId,
    config,
    ica,
    origin,
    originOwner,
    chains,
  }) => {
    logCommandHeader('Hyperlane Warp Check');

    let { warpCoreConfig, warpDeployConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: config,
      warpCoreConfigPath: warp,
    });

    // If --ica flag is set, run ICA owner check instead of the regular config check
    // Note: ICA check uses full warpDeployConfig (not filtered) to support pre-deployed chains
    if (ica) {
      assert(origin, '--origin is required when using --ica');

      await runWarpIcaOwnerCheck({
        context,
        warpDeployConfig,
        origin,
        originOwner,
        chains: chains?.length ? chains : undefined,
      });

      process.exit(0);
    }

    ({ warpCoreConfig, warpDeployConfig } = filterWarpConfigsToMatchingChains(
      warpDeployConfig,
      warpCoreConfig,
    ));

    const deployedRoutersAddresses =
      getRouterAddressesFromWarpCoreConfig(warpCoreConfig);

    // Remove any non EVM chain configs to avoid the checker crashing
    warpCoreConfig.tokens = warpCoreConfig.tokens.filter(
      (config) =>
        context.multiProvider.getProtocol(config.chainName) ===
        ProtocolType.Ethereum,
    );

    // Get on-chain config
    const onChainWarpConfig = await getWarpRouteConfigsByCore({
      context,
      warpCoreConfig,
    });

    // get virtual on-chain config
    const expandedOnChainWarpConfig = await expandVirtualWarpDeployConfig({
      multiProvider: context.multiProvider,
      onChainWarpConfig,
      deployedRoutersAddresses,
    });

    let expandedWarpDeployConfig = await expandWarpDeployConfig({
      multiProvider: context.multiProvider,
      warpDeployConfig,
      deployedRoutersAddresses,
      expandedOnChainWarpConfig,
    });
    expandedWarpDeployConfig = objFilter(
      expandedWarpDeployConfig,
      (chain, _config): _config is any =>
        context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
    );

    await runWarpRouteCheck({
      onChainWarpConfig: expandedOnChainWarpConfig,
      warpRouteConfig: expandedWarpDeployConfig,
    });

    process.exit(0);
  },
};

export const rebalancer: CommandModuleWithWriteContext<{
  config: string;
  checkFrequency: number;
  withMetrics: boolean;
  monitorOnly: boolean;
  manual?: boolean;
  origin?: string;
  destination?: string;
  amount?: string;
}> = {
  command: 'rebalancer',
  describe: 'Run a warp route collateral rebalancer',
  builder: {
    config: {
      type: 'string',
      description:
        'The path to a rebalancer configuration file (.json or .yaml)',
      demandOption: true,
      alias: ['rebalancerConfigFile', 'rebalancerConfig', 'configFile'],
    },
    checkFrequency: {
      type: 'number',
      description: 'Frequency to check balances in ms (defaults: 30 seconds)',
      demandOption: false,
      default: 60000,
    },
    withMetrics: {
      type: 'boolean',
      description: 'Enable metrics (default: true)',
      demandOption: false,
      default: false,
    },
    monitorOnly: {
      type: 'boolean',
      description: 'Run in monitor only mode (default: false)',
      demandOption: false,
      default: false,
    },
    manual: {
      type: 'boolean',
      description:
        'Trigger a rebalancer manual run (default: false, requires --origin, --destination, --amount)',
      demandOption: false,
      implies: ['origin', 'destination', 'amount'],
    },
    origin: {
      type: 'string',
      description: 'The origin chain for manual rebalance',
      demandOption: false,
      implies: 'manual',
    },
    destination: {
      type: 'string',
      description: 'The destination chain for manual rebalance',
      demandOption: false,
      implies: 'manual',
    },
    amount: {
      type: 'string',
      description:
        'The amount to transfer from origin to destination on manual rebalance. Defined in token units (E.g 100 instead of 100000000 wei for USDC)',
      demandOption: false,
      implies: 'manual',
    },
  },
  handler: async (args) => {
    const {
      context,
      config: configPath,
      checkFrequency,
      withMetrics,
      monitorOnly,
      manual,
      origin,
      destination,
      amount,
    } = args;

    logCommandHeader('Hyperlane Warp Route Rebalancer');

    try {
      // Load rebalancer configuration
      const rebalancerConfig = RebalancerConfig.load(configPath);

      // Determine execution mode
      const mode = manual ? 'manual' : 'daemon';

      // Create rebalancer service
      const service = new RebalancerService(
        context.multiProvider,
        context.multiProtocolProvider,
        context.registry,
        rebalancerConfig,
        {
          mode,
          checkFrequency,
          withMetrics,
          monitorOnly,
          coingeckoApiKey: process.env.COINGECKO_API_KEY,
          logger: rootLogger.child({ module: 'rebalancer' }),
        },
      );

      // Execute based on mode
      if (manual) {
        if (!origin || !destination || !amount) {
          errorRed(
            'Origin, destination, and amount are required for manual rebalance',
          );
          process.exit(1);
        }

        await service.executeManual({
          origin,
          destination,
          amount,
        });

        logGreen('✅ Manual rebalance completed successfully');
      } else {
        // Start daemon mode
        await service.start();
      }
    } catch (e: any) {
      errorRed(`Rebalancer error: ${util.format(e)}`);
      process.exit(1);
    }
  },
};

export const verify: CommandModuleWithWriteContext<SelectWarpRouteBuilder> = {
  command: 'verify',
  describe: 'Verify deployed contracts on explorers',
  builder: SELECT_WARP_ROUTE_BUILDER,
  handler: async ({ context, symbol, config, warp, warpRouteId }) => {
    logCommandHeader('Hyperlane Warp Verify');

    const { warpCoreConfig } = await getWarpConfigs({
      context,
      symbol,
      warpRouteId,
      warpDeployConfigPath: config,
      warpCoreConfigPath: warp,
    });

    return runVerifyWarpRoute({ context, warpCoreConfig });
  },
};

const fork: CommandModuleWithContext<
  SelectWarpRouteBuilder & {
    port?: number;
    'fork-config'?: string;
    kill: boolean;
  }
> = {
  command: 'fork',
  describe: 'Fork a Hyperlane chain on a compatible Anvil/Hardhat node',
  builder: {
    ...forkCommandOptions,
    ...SELECT_WARP_ROUTE_BUILDER,
  },
  handler: async ({
    context,
    symbol,
    warpRouteId,
    port,
    kill,
    warp,
    config,
    forkConfig: forkConfigPath,
  }) => {
    let forkConfig: RawForkedChainConfigByChain;
    if (forkConfigPath) {
      forkConfig = RawForkedChainConfigByChainSchema.parse(
        readYamlOrJson(forkConfigPath),
      );
    } else {
      forkConfig = {};
    }

    // Get chains from warp deploy config
    const { warpDeployConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: config,
      warpCoreConfigPath: warp,
    });
    const chainsToFork = new Set(Object.keys(warpDeployConfig));
    logBlue(
      `Forking chains from warp deploy config: ${Array.from(chainsToFork).join(', ')}`,
    );

    await runForkCommand({
      context,
      chainsToFork,
      forkConfig,
      basePort: port,
      kill,
    });
  },
};
