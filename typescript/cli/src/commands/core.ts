import { CommandModule } from 'yargs';

import { createHooksConfigMap } from '../config/hooks.js';
import { createIsmConfigMap } from '../config/ism.js';
import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';

import { deployCoreCommand } from './deploy.js';
import { outputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Manage core Hyperlane contracts & configs',
  builder: (yargs) =>
    yargs
      .command(deployCoreCommand)
      .command(config)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const config: CommandModuleWithContext<{
  ismAdvanced: boolean;
  ismOut: string;
  hooksOut: string;
}> = {
  command: 'config',
  describe: 'Create a core configuration, including ISMs and hooks.',
  builder: {
    ismAdvanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM & hook configuration',
      default: false,
    },
    ismOut: outputFileCommandOption('./configs/ism.yaml'),
    hooksOut: outputFileCommandOption('./configs/hooks.yaml'),
  },
  handler: async ({ context, ismAdvanced, ismOut, hooksOut }) => {
    await createIsmConfigMap({
      context,
      outPath: ismOut,
      shouldUseDefault: !ismAdvanced,
    });
    await createHooksConfigMap({
      context,
      outPath: hooksOut,
    });

    process.exit(0);
  },
};
