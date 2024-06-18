import { select } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  ChainMap,
  EvmERC20WarpRouteReader,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { createWarpRouteDeployConfig } from '../config/warp.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logGray, logGreen, logRed } from '../logger.js';
import { sendTestTransfer } from '../send/transfer.js';
import { indentYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  addressCommandOption,
  chainCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  outputFileCommandOption,
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
      .command(configure)
      .command(deploy)
      .command(read)
      .command(send)
      .version(false)
      .demandCommand(),

  handler: () => log('Command required'),
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
    logGray(`Hyperlane warp route deployment${dryRun ? ' dry-run' : ''}`);
    logGray('------------------------------------------------');

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

export const configure: CommandModuleWithContext<{
  advanced: boolean;
  out: string;
}> = {
  command: 'configure',
  describe: 'Create a warp route configuration.',
  builder: {
    advanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM',
      default: false,
    },
    out: outputFileCommandOption('./configs/warp-route-deployment.yaml'),
  },
  handler: async ({ context, advanced, out }) => {
    logGray('Hyperlane Warp Configure');
    logGray('------------------------');

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
  out?: string;
  symbol?: string;
}> = {
  command: 'read',
  describe: 'Reads the warp route config at the given path.',
  builder: {
    symbol: {
      type: 'string',
      description: 'Identify warp route in registry by symbol',
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
    out: outputFileCommandOption(),
  },
  handler: async ({ context, chain, address, out, symbol }) => {
    logGray('Hyperlane Warp Reader');
    logGray('---------------------');

    const { multiProvider } = context;

    let addresses: ChainMap<string>;
    if (symbol) {
      const matching = await context.registry.getWarpRoutes({
        symbol,
      });
      const routes = Object.entries(matching);

      let warpCoreConfig: WarpCoreConfig;
      if (routes.length === 0) {
        logRed(`No warp routes found for symbol ${symbol}`);
        process.exit(0);
      } else if (routes.length === 1) {
        warpCoreConfig = routes[0][1];
      } else {
        logGreen(`Multiple warp routes found for symbol ${symbol}`);
        const chosenRouteId = await select({
          message: 'Select from matching warp routes',
          choices: routes.map(([routeId, _]) => ({
            value: routeId,
          })),
        });
        warpCoreConfig = matching[chosenRouteId];
      }

      addresses = Object.fromEntries(
        warpCoreConfig.tokens.map((t) => [t.chainName, t.addressOrDenom!]),
      );
    } else if (chain && address) {
      addresses = {
        [chain]: address,
      };
    } else {
      logGreen(`Please specify either a symbol or chain and address`);
      process.exit(0);
    }

    const config = await promiseObjAll(
      objMap(addresses, async (chain, address) =>
        new EvmERC20WarpRouteReader(multiProvider, chain).deriveWarpRouteConfig(
          address,
        ),
      ),
    );

    if (out) {
      writeYamlOrJson(out, config, 'yaml');
      logGreen(`✅ Warp route config written successfully to ${out}:\n`);
    } else {
      logGreen(`✅ Warp route config read successfully:\n`);
    }
    log(indentYamlOrJson(yamlStringify(config, null, 2), 4));
    process.exit(0);
  },
};

const send: CommandModuleWithWriteContext<
  MessageOptionsArgTypes & {
    warp: string;
    router?: string;
    wei: string;
    recipient?: string;
  }
> = {
  command: 'send',
  describe: 'Send a test token transfer on a warp route',
  builder: {
    ...messageOptions,
    warp: warpCoreConfigCommandOption,
    wei: {
      type: 'string',
      description: 'Amount in wei to send',
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
    warp,
    wei,
    recipient,
  }) => {
    await sendTestTransfer({
      context,
      warpConfigPath: warp,
      origin,
      destination,
      wei,
      recipient,
      timeoutSec: timeout,
      skipWaitForDelivery: quick,
      selfRelay: relay,
    });
    process.exit(0);
  },
};
