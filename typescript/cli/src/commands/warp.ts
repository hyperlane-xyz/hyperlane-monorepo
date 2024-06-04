import { CommandModule } from 'yargs';

import { EvmERC20WarpRouteReader } from '@hyperlane-xyz/sdk';

import { createWarpRouteDeployConfig } from '../config/warp.js';
import { CommandModuleWithContext } from '../context/types.js';
import { log, logGray, logGreen } from '../logger.js';
import { writeFileAtPath } from '../utils/files.js';

import {
  addressCommandOption,
  chainCommandOption,
  outputFileCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const warpCommand: CommandModule = {
  command: 'warp',
  describe: 'Manage Hyperlane warp routes',
  builder: (yargs) =>
    yargs.command(configure).command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};

export const configure: CommandModuleWithContext<{
  ismAdvanced: boolean;
  out: string;
}> = {
  command: 'configure',
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
