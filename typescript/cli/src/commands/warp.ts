import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  ChainName,
  ChainSubmissionStrategySchema,
  expandVirtualWarpDeployConfig,
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, objFilter, toWei } from '@hyperlane-xyz/utils';

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
import {
  errorRed,
  log,
  logBlue,
  logCommandHeader,
  logGreen,
  warnYellow,
} from '../logger.js';
import { getWarpRouteConfigsByCore, runWarpRouteRead } from '../read/warp.js';
import {
  Config,
  MonitorEventType,
  MonitorPollingError,
  RebalancerContextFactory,
  StrategyOptions,
} from '../rebalancer/index.js';
import { getRawBalances } from '../rebalancer/utils/getRawBalances.js';
import { sendTestTransfer } from '../send/transfer.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { ENV } from '../utils/env.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  removeEndingSlash,
  writeYamlOrJson,
} from '../utils/files.js';
import { selectRegistryWarpRoute } from '../utils/tokens.js';
import {
  filterWarpConfigsToMatchingChains,
  getWarpConfigs,
  getWarpCoreConfigOrExit,
} from '../utils/warp.js';
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
      .command(init)
      .command(read)
      .command(rebalancer)
      .command(send)
      .command(verify)
      .version(false)
      .demandCommand(),

  handler: () => log('Command required'),
};

export const apply: CommandModuleWithWarpApplyContext<{
  config?: string;
  warp?: string;
  symbol?: string;
  warpRouteId?: string;
  strategy?: string;
  receiptsDir: string;
}> = {
  command: 'apply',
  describe: 'Update Warp Route contracts',
  builder: {
    config: warpDeploymentConfigCommandOption,
    warpRouteId: warpRouteIdCommandOption,
    warp: {
      ...warpCoreConfigCommandOption,
      demandOption: false,
    },
    symbol: {
      ...symbolCommandOption,
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
  handler: async ({ context, strategy: strategyUrl, receiptsDir }) => {
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
    });
    process.exit(0);
  },
};

export const deploy: CommandModuleWithWarpDeployContext<{
  config?: string;
  'dry-run': string;
  'from-address': string;
  symbol?: string;
  warpRouteId?: string;
}> = {
  command: 'deploy',
  describe: 'Deploy Warp Route contracts',
  builder: {
    config: warpDeploymentConfigCommandOption,
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    warpRouteId: warpRouteIdCommandOption,
  },
  handler: async ({ context, dryRun }) => {
    logCommandHeader(
      `Hyperlane Warp Route Deployment${dryRun ? ' Dry-Run' : ''}`,
    );

    try {
      await runWarpRouteDeploy({
        context,
        // Already fetched in the resolveWarpRouteConfigChains
        warpDeployConfig: context.warpDeployConfig,
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
  config?: string;
  symbol?: string;
  warp?: string;
  warpRouteId?: string;
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
      description: 'The path to a warp route deployment configuration file',
      demandOption: false,
      alias: 'wd',
    }),
    warpRouteId: warpRouteIdCommandOption,
  },
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
  withMetrics?: boolean;
  monitorOnly?: boolean;
  coingeckoApiKey?: string;
  rebalanceStrategy?: StrategyOptions;
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
      description: 'Frequency to check balances in ms',
      demandOption: true,
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
    coingeckoApiKey: {
      type: 'string',
      description: 'CoinGecko API key',
      demandOption: false,
      alias: ['g', 'coingecko-api-key'],
      implies: 'withMetrics',
    },
    rebalanceStrategy: {
      type: 'string',
      description: 'Rebalancer strategy (weighted, minAmount, manual)',
      demandOption: false,
      alias: ['rs', 'rebalance-strategy'],
    },
    origin: {
      type: 'string',
      description: 'The origin chain for manual rebalance',
      demandOption: false,
    },
    destination: {
      type: 'string',
      description: 'The destination chain for manual rebalance',
      demandOption: false,
    },
    amount: {
      type: 'string',
      description:
        'The amount to transfer from origin to destination on manual rebalance. Defined in token units (E.g 100 instead of 100000000 wei for USDC)',
      demandOption: false,
    },
  },
  handler: async ({
    context,
    config,
    checkFrequency,
    withMetrics,
    monitorOnly,
    coingeckoApiKey = ENV.COINGECKO_API_KEY,
    rebalanceStrategy,
    origin,
    destination,
    amount,
  }) => {
    try {
      const { registry, key: rebalancerKey } = context;

      // Load rebalancer config from disk
      const rebalancerConfig = Config.load(config, rebalancerKey, {
        checkFrequency,
        withMetrics,
        monitorOnly,
        coingeckoApiKey,
        rebalanceStrategy,
      });
      logGreen('✅ Loaded rebalancer config');

      // Instantiate the factory used to create the different rebalancer components
      const contextFactory = await RebalancerContextFactory.create(
        registry,
        rebalancerConfig,
      );

      if (rebalanceStrategy === StrategyOptions.Manual) {
        if (!origin) {
          throw new Error('--origin is required for manual rebalance');
        }

        if (!destination) {
          throw new Error('--destination is required for manual rebalance');
        }

        if (!amount) {
          throw new Error('--amount is required for manual rebalance');
        }

        warnYellow(
          `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
        );

        const warpCore = contextFactory.getWarpCore();
        const executor = contextFactory.createExecutor();
        const originToken = warpCore.tokens.find((t) => t.chainName === origin);

        await executor.rebalance([
          {
            origin,
            destination,
            amount: BigInt(toWei(amount, originToken!.decimals)),
          },
        ]);

        process.exit(0);
      }

      // Instantiates the monitor that will observe the warp route
      const monitor = contextFactory.createMonitor();

      // Instantiates the strategy that will compute how rebalance routes should be performed
      const strategy = await contextFactory.createStrategy();

      // Instantiates the executor in charge of executing the rebalancing transactions
      const executor = !rebalancerConfig.monitorOnly
        ? contextFactory.createExecutor()
        : undefined;

      if (rebalancerConfig.monitorOnly) {
        warnYellow(
          'Running in monitorOnly mode: no transactions will be executed.',
        );
      }

      // Instantiates the metrics that will publish stats from the monitored data
      const metrics = withMetrics
        ? await contextFactory.createMetrics()
        : undefined;

      if (withMetrics) {
        warnYellow(
          'Metrics collection has been enabled and will be gathered during execution',
        );
      }

      await monitor
        // Observe balances events and process rebalancing routes
        .on(MonitorEventType.TokenInfo, (event) => {
          if (metrics) {
            for (const tokenInfo of event.tokensInfo) {
              metrics.processToken(tokenInfo).catch((e) => {
                errorRed(
                  `Error building metrics for ${tokenInfo.token.addressOrDenom}: ${e.message}`,
                );
              });
            }
          }

          const rawBalances = getRawBalances(
            Object.keys(rebalancerConfig.chains),
            event,
          );

          const rebalancingRoutes = strategy.getRebalancingRoutes(rawBalances);

          executor?.rebalance(rebalancingRoutes).catch((e) => {
            errorRed('Error while rebalancing:', (e as Error).message);
          });
        })
        // Observe monitor errors and exit
        .on(MonitorEventType.Error, (e) => {
          if (e instanceof MonitorPollingError) {
            errorRed(e);
          } else {
            // This will catch `MonitorStartError` and generic errors
            throw e;
          }
        })
        // Observe monitor start and log success
        .on(MonitorEventType.Start, () => {
          logGreen('Rebalancer started successfully 🚀');
        })
        // Finally, starts the monitor to begin polling balances.
        .start();
    } catch (e) {
      errorRed('Rebalancer error:', (e as Error).message);
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
