import { CommandModule } from 'yargs';

import { EvmERC20WarpRouteReader } from '@hyperlane-xyz/sdk';

import { createWarpRouteDeployConfig } from '../config/warp.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { log, logGray, logGreen } from '../logger.js';
import { sendTestTransfer } from '../send/transfer.js';
import { writeFileAtPath } from '../utils/files.js';

import {
  addressCommandOption,
  chainCommandOption,
  outputFileCommandOption,
  warpCoreConfigCommandOption,
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
      .command(config)
      .command(read)
      .command(send)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const config: CommandModuleWithContext<{
  ismAdvanced: boolean;
  out: string;
}> = {
  command: 'config',
  describe: 'Create a warp route configuration.',
  builder: {
    ismAdvanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM & hook configuration',
      default: false,
    },
    out: outputFileCommandOption('./configs/warp-route-deployment.yaml'),
  },
  handler: async ({ context, ismAdvanced, out }) => {
    await createWarpRouteDeployConfig({
      context,
      outPath: out,
      shouldUseDefault: !ismAdvanced,
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
      writeFileAtPath(out, JSON.stringify(warpRouteConfig, null, 4) + '\n');
      logGreen(`✅ Warp route config written successfully to ${out}.`);
    } else {
      logGreen(`✅ Warp route config read successfully:`);
      log(JSON.stringify(warpRouteConfig, null, 4));
    }
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
