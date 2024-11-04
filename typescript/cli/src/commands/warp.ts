import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import { ChainSubmissionStrategySchema } from '@hyperlane-xyz/sdk';

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
import { log, logCommandHeader, logGreen } from '../logger.js';
import { runWarpRouteRead } from '../read/warp.js';
import { sendTestTransfer } from '../send/transfer.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  removeEndingSlash,
  writeYamlOrJson,
} from '../utils/files.js';
import { getWarpCoreConfigOrExit } from '../utils/input.js';
import { selectRegistryWarpRoute } from '../utils/tokens.js';
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
import { MessageOptionsArgTypes, messageOptions } from './send.js';

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
    const warpDeployConfig = await readWarpRouteDeployConfig(config);

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
    ...messageOptions,
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
  }) => {
    const warpCoreConfig = await getWarpCoreConfigOrExit({
      symbol,
      warp,
      context,
    });

    await sendTestTransfer({
      context,
      warpCoreConfig,
      origin,
      destination,
      amount,
      recipient,
      timeoutSec: timeout,
      skipWaitForDelivery: quick,
      selfRelay: relay,
    });
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

    await runWarpRouteCheck({
      onChainWarpConfig,
      warpRouteConfig,
    });

    process.exit(0);
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
