import util from 'util';
import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  ChainName,
  ChainSubmissionStrategySchema,
  RawForkedChainConfigByChain,
  RawForkedChainConfigByChainSchema,
  expandVirtualWarpDeployConfig,
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, objFilter } from '@hyperlane-xyz/utils';

import { runWarpRouteCheck } from '../check/warp.js';
import { createWarpRouteDeployConfig } from '../config/warp.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWarpApplyContext,
  CommandModuleWithWarpDeployContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
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
import { RebalancerRunner } from '../rebalancer/runner.js';
import { sendTestTransfer } from '../send/transfer.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  removeEndingSlash,
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
  dryRunCommandOption,
  forkCommandOptions,
  fromAddressCommandOption,
  outputFileCommandOption,
  strategyCommandOption,
  symbolCommandOption,
  warpCoreConfigCommandOption,
  warpDeploymentConfigCommandOption,
  warpRouteIdCommandOption,
} from './options.js';
import { MessageOptionsArgTypes, messageSendOptions } from './send.js';

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
      coerce: (dir) => removeEndingSlash(dir),
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
      ChainSubmissionStrategySchema.parse(readYamlOrJson(strategyUrl));

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

export const deploy: CommandModuleWithWarpDeployContext<
  SelectWarpRouteBuilder & {
    'dry-run': string;
    'from-address': string;
  }
> = {
  command: 'deploy',
  describe: 'Deploy Warp Route contracts',
  builder: {
    ...SELECT_WARP_ROUTE_BUILDER,
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
  },
  handler: async ({ context, dryRun, warpRouteId, config }) => {
    logCommandHeader(
      `Hyperlane Warp Route Deployment${dryRun ? ' Dry-Run' : ''}`,
    );

    try {
      await runWarpRouteDeploy({
        context,
        // Already fetched in the resolveWarpRouteConfigChains
        warpDeployConfig: context.warpDeployConfig,
        warpRouteId,
        warpDeployConfigFileName: config,
      });
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
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
  }) => {
    logCommandHeader('Hyperlane Warp Reader');

    const config = await runWarpRouteRead({
      context,
      chain,
      address,
      symbol,
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
  }) => {
    const warpCoreConfig = await getWarpCoreConfigOrExit({
      symbol,
      warp,
      context,
    });

    let chains: ChainName[] = warpCoreConfig.tokens.map((t) => t.chainName);
    if (roundTrip) {
      // Appends the reverse of the array, excluding the 1st (e.g. [1,2,3] becomes [1,2,3,2,1])
      const reversed = [...chains].reverse().slice(1, chains.length + 1); // We make a copy because .reverse() is mutating
      chains.push(...reversed);
    } else {
      // Assume we want to use use `--origin` and `--destination` params, prompt as needed.
      const chainMetadata = objFilter(
        context.chainMetadata,
        (key, _metadata): _metadata is any => chains.includes(key),
      );

      if (!origin)
        origin = await runSingleChainSelectionStep(
          chainMetadata,
          'Select the origin chain:',
        );

      if (!destination)
        destination = await runSingleChainSelectionStep(
          chainMetadata,
          'Select the destination chain:',
        );

      chains = [origin, destination].filter((c) => chains.includes(c));

      assert(
        chains.length === 2,
        `Origin (${origin}) or destination (${destination}) are not part of the warp route.`,
      );
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
    });
    logGreen(
      `✅ Successfully sent messages for chains: ${chains.join(' ➡️ ')}`,
    );
    process.exit(0);
  },
};

export const check: CommandModuleWithContext<SelectWarpRouteBuilder> = {
  command: 'check',
  describe:
    'Verifies that a warp route configuration matches the on chain configuration.',
  builder: SELECT_WARP_ROUTE_BUILDER,
  handler: async ({ context, symbol, warp, warpRouteId, config }) => {
    logCommandHeader('Hyperlane Warp Check');

    let { warpCoreConfig, warpDeployConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: config,
      warpCoreConfigPath: warp,
    });

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
    let runner: RebalancerRunner;
    try {
      const { context, ...rest } = args;
      runner = await RebalancerRunner.create(rest, context);
    } catch (e: any) {
      // exit on startup errors
      errorRed('Rebalancer startup error:', util.format(e));
      process.exit(1);
    }

    try {
      await runner.run();
    } catch (e: any) {
      errorRed('Rebalancer error:', util.format(e));
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
    const { warpCoreConfig, warpDeployConfig } = await getWarpConfigs({
      context,
      warpRouteId,
      symbol,
      warpDeployConfigPath: config,
      warpCoreConfigPath: warp,
    });

    let forkConfig: RawForkedChainConfigByChain;
    if (forkConfigPath) {
      forkConfig = RawForkedChainConfigByChainSchema.parse(
        readYamlOrJson(forkConfigPath),
      );
    } else {
      forkConfig = {};
    }

    await runForkCommand({
      context,
      chainsToFork: new Set([
        ...warpCoreConfig.tokens.map((tokenConfig) => tokenConfig.chainName),
        ...Object.keys(warpDeployConfig),
      ]),
      forkConfig,
      basePort: port,
      kill,
    });
  },
};
