import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  ChainName,
  ChainSubmissionStrategySchema,
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { assert, objFilter } from '@hyperlane-xyz/utils';

import { runWarpRouteCheck } from '../check/warp.js';
import {
  createWarpRouteDeployConfig,
  readWarpRouteDeployConfig,
} from '../config/warp.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteApply, runWarpRouteDeploy } from '../deploy/warp.js';
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
} from '../logger.js';
import { runWarpRouteRead } from '../read/warp.js';
import {
  Config,
  IExecutor,
  IStrategy,
  RawBalances,
  RebalancerContextFactory,
} from '../rebalancer/index.js';
// TODO: This import should come from the IMonitor interface
import { MonitorPollingError } from '../rebalancer/monitor/Monitor.js';
import { sendTestTransfer } from '../send/transfer.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  removeEndingSlash,
  writeYamlOrJson,
} from '../utils/files.js';
import { selectRegistryWarpRoute } from '../utils/tokens.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';
import { runVerifyWarpRoute } from '../verify/warp.js';

import {
  DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
  addressCommandOption,
  chainCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  inputFileCommandOption,
  outputFileCommandOption,
  strategyCommandOption,
  symbolCommandOption,
  warpCoreConfigCommandOption,
  warpDeploymentConfigCommandOption,
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
      .command(init)
      .command(read)
      .command(rebalancer)
      .command(send)
      .command(verify)
      .version(false)
      .demandCommand(),

  handler: () => log('Command required'),
};

export const apply: CommandModuleWithWriteContext<{
  config: string;
  symbol?: string;
  warp: string;
  strategy?: string;
  receiptsDir: string;
}> = {
  command: 'apply',
  describe: 'Update Warp Route contracts',
  builder: {
    config: warpDeploymentConfigCommandOption,
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    warp: {
      ...warpCoreConfigCommandOption,
      demandOption: false,
    },
    strategy: { ...strategyCommandOption, demandOption: false },
    'receipts-dir': {
      type: 'string',
      description: 'The directory to output transaction receipts.',
      default: './generated/transactions',
      coerce: (dir) => removeEndingSlash(dir),
    },
  },
  handler: async ({
    context,
    config,
    symbol,
    warp,
    strategy: strategyUrl,
    receiptsDir,
  }) => {
    logCommandHeader('Hyperlane Warp Apply');

    const warpCoreConfig = await getWarpCoreConfigOrExit({
      symbol,
      warp,
      context,
    });

    if (strategyUrl)
      ChainSubmissionStrategySchema.parse(readYamlOrJson(strategyUrl));
    const warpDeployConfig = await readWarpRouteDeployConfig(config, context);

    await runWarpRouteApply({
      context,
      warpDeployConfig,
      warpCoreConfig,
      strategyUrl,
      receiptsDir,
    });
    process.exit(0);
  },
};

export const deploy: CommandModuleWithWriteContext<{
  config: string;
  'dry-run': string;
  'from-address': string;
}> = {
  command: 'deploy',
  describe: 'Deploy Warp Route contracts',
  builder: {
    config: warpDeploymentConfigCommandOption,
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
  },
  handler: async ({ context, config, dryRun }) => {
    logCommandHeader(
      `Hyperlane Warp Route Deployment${dryRun ? ' Dry-Run' : ''}`,
    );

    try {
      await runWarpRouteDeploy({
        context,
        warpRouteDeploymentConfigPath: config,
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
    out: outputFileCommandOption(DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH),
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

export const read: CommandModuleWithContext<{
  chain?: string;
  address?: string;
  config?: string;
  symbol?: string;
}> = {
  command: 'read',
  describe: 'Derive the warp route config from onchain artifacts',
  builder: {
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    chain: {
      ...chainCommandOption,
      demandOption: false,
    },
    address: addressCommandOption(
      'Address of the router contract to read.',
      false,
    ),
    config: outputFileCommandOption(
      DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
      false,
      'The path to output a Warp Config JSON or YAML file.',
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
  MessageOptionsArgTypes & {
    warp?: string;
    symbol?: string;
    router?: string;
    amount: string;
    recipient?: string;
  }
> = {
  command: 'send',
  describe: 'Send a test token transfer on a warp route',
  builder: {
    ...messageSendOptions,
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    warp: {
      ...warpCoreConfigCommandOption,
      demandOption: false,
    },
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

export const check: CommandModuleWithContext<{
  config: string;
  symbol?: string;
  warp?: string;
}> = {
  command: 'check',
  describe:
    'Verifies that a warp route configuration matches the on chain configuration.',
  builder: {
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    warp: {
      ...warpCoreConfigCommandOption,
      demandOption: false,
    },
    config: inputFileCommandOption({
      defaultPath: DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
      description: 'The path to a warp route deployment configuration file',
    }),
  },
  handler: async ({ context, config, symbol, warp }) => {
    logCommandHeader('Hyperlane Warp Check');

    const warpRouteConfig = await readWarpRouteDeployConfig(config, context);
    const onChainWarpConfig = await runWarpRouteRead({
      context,
      warp,
      symbol,
    });

    const warpCoreConfig =
      context.warpCoreConfig ??
      (await getWarpCoreConfigOrExit({
        context,
        warp,
        symbol,
      }));

    if (!warpCoreConfig) {
      throw new Error('No warp core config found');
    }

    const expandedWarpDeployConfig = await expandWarpDeployConfig(
      context.multiProvider,
      warpRouteConfig,
      getRouterAddressesFromWarpCoreConfig(warpCoreConfig),
    );

    await runWarpRouteCheck({
      onChainWarpConfig,
      warpRouteConfig: expandedWarpDeployConfig,
    });

    process.exit(0);
  },
};

export const rebalancer: CommandModuleWithWriteContext<{
  configFile: string;
  warpRouteId?: string;
  checkFrequency?: number;
  withMetrics?: boolean;
  monitorOnly?: boolean;
}> = {
  command: 'rebalancer',
  describe: 'Run a warp route collateral rebalancer',
  builder: {
    configFile: {
      type: 'string',
      description:
        'The path to a rebalancer configuration file (.json or .yaml)',
      demandOption: true,
      alias: ['rebalancerConfigFile'],
    },
    warpRouteId: {
      type: 'string',
      description: 'The warp route ID to rebalance',
      demandOption: false,
    },
    checkFrequency: {
      type: 'number',
      description: 'Frequency to check balances in ms',
      demandOption: false,
    },
    withMetrics: {
      type: 'boolean',
      description: 'Enable metrics',
      demandOption: false,
    },
    monitorOnly: {
      type: 'boolean',
      description: 'Run in monitor only mode',
      demandOption: false,
    },
  },
  handler: async ({
    context,
    configFile,
    warpRouteId,
    checkFrequency,
    withMetrics,
    monitorOnly,
  }) => {
    try {
      const { registry, key: rebalancerKey } = context;

      // Load rebalancer config from disk
      const config = Config.load(configFile, rebalancerKey, {
        warpRouteId,
        checkFrequency,
        withMetrics,
        monitorOnly,
      });

      // Instantiate the factory used to create the different rebalancer components
      const contextFactory = await RebalancerContextFactory.create(
        registry,
        config,
      );

      // Instantiates the monitor that will observe the warp route
      const monitor = contextFactory.createMonitor();

      // Instantiates the strategy that will compute how rebalance routes should be performed
      const strategy: IStrategy = contextFactory.createStrategy();

      // Instantiates the executor in charge of executing the rebalancing transactions
      const executor: IExecutor = contextFactory.createExecutor();

      // Instantiates the metrics that will publish stats from the monitored data
      const metrics = config.withMetrics
        ? await contextFactory.createMetrics()
        : undefined;

      await monitor
        // Observe balances events and process rebalancing routes
        .on('tokeninfo', (event) => {
          if (metrics) {
            for (const tokenInfo of event.tokensInfo) {
              metrics.processToken(tokenInfo).catch((e) => {
                errorRed(
                  `Error building metrics for ${tokenInfo.token.addressOrDenom}: ${e.message}`,
                );
              });
            }
          }

          const rawBalances = event.tokensInfo.reduce((acc, tokenInfo) => {
            if (
              !tokenInfo.token.isCollateralized() ||
              tokenInfo.bridgedSupply === undefined
            ) {
              return acc;
            }
            acc[tokenInfo.token.chainName] = tokenInfo.bridgedSupply;
            return acc;
          }, {} as RawBalances);

          const rebalancingRoutes = strategy.getRebalancingRoutes(rawBalances);

          executor.rebalance(rebalancingRoutes).catch((e) => {
            errorRed('Error while rebalancing:', (e as Error).message);
          });
        })
        // Observe monitor errors and exit
        .on('error', (e) => {
          if (e instanceof MonitorPollingError) {
            errorRed(e);
          } else {
            // This will catch `MonitorStartError` and generic errors
            throw e;
          }
        })
        // Observe monitor start and log success
        .on('start', () => {
          logGreen('Rebalancer started successfully 🚀');
        })
        // Finally, starts the monitor to begin polling balances.
        .start();
    } catch (e) {
      errorRed('Error on the rebalancer:', (e as Error).message);
      process.exit(1);
    }
  },
};

export const verify: CommandModuleWithWriteContext<{
  symbol: string;
}> = {
  command: 'verify',
  describe: 'Verify deployed contracts on explorers',
  builder: {
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
  },
  handler: async ({ context, symbol }) => {
    logCommandHeader('Hyperlane Warp Verify');
    const warpCoreConfig = await selectRegistryWarpRoute(
      context.registry,
      symbol,
    );

    return runVerifyWarpRoute({ context, warpCoreConfig });
  },
};
