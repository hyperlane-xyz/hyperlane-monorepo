import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import { EvmERC20WarpRouteReader } from '@hyperlane-xyz/sdk';

import { createWarpRouteDeployConfig } from '../config/warp.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logGray, logGreen } from '../logger.js';
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
  chain: string;
  address: string;
  out: string;
}> = {
  command: 'read',
  describe: 'Reads the warp route config at the given path.',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    address: addressCommandOption(
      'Address of the router contract to read.',
      true,
    ),
    out: outputFileCommandOption(),
  },
  handler: async ({ context, chain, address, out }) => {
    logGray('Hyperlane Warp Reader');
    logGray('---------------------');

    const { multiProvider } = context;
    const evmERC20WarpRouteReader = new EvmERC20WarpRouteReader(
      multiProvider,
      chain,
    );
    const warpRouteConfig = await evmERC20WarpRouteReader.deriveWarpRouteConfig(
      address,
    );
    if (out) {
      writeYamlOrJson(out, warpRouteConfig, 'yaml');
      logGreen(`✅ Warp route config written successfully to ${out}:\n`);
    } else {
      logGreen(`✅ Warp route config read successfully:\n`);
    }
    log(indentYamlOrJson(yamlStringify(warpRouteConfig, null, 2), 4));
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
