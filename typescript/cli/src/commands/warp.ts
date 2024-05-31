import { CommandModule } from 'yargs';

import { createWarpRouteDeployConfig } from '../config/warp.js';
import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';

import { outputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const warpCommand: CommandModule = {
  command: 'warp',
  describe: 'Manage Hyperlane warp routes',
  builder: (yargs) => yargs.command(config).version(false).demandCommand(),
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
