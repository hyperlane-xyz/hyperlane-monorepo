import { CommandModule } from 'yargs';

import {
  createWarpRouteDeployConfig,
  readWarpRouteDeployConfig,
} from '../config/warp.js';
import { CommandModuleWithContext } from '../context/types.js';
import { log, logGreen } from '../logger.js';

import { inputFileCommandOption, outputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const warpCommand: CommandModule = {
  command: 'warp',
  describe: 'Manage Hyperlane warp routes',
  builder: (yargs) =>
    yargs.command(config).command(read).version(false).demandCommand(),
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
  path: string;
  out: string;
}> = {
  command: 'read',
  describe: 'Reads the warp route config at the given path.',
  builder: {
    path: inputFileCommandOption,
  },
  handler: async ({ context, path }) => {
    await readWarpRouteDeployConfig(path, context);
    logGreen('✅ Warp route config read successfully');
    process.exit(0);
  },
};
