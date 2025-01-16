import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  createStrategyConfig,
  readChainSubmissionStrategyConfig,
} from '../config/strategy.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { log, logCommandHeader } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import { maskSensitiveData } from '../utils/output.js';

import {
  DEFAULT_STRATEGY_CONFIG_PATH,
  outputFileCommandOption,
  strategyCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const strategyCommand: CommandModule = {
  command: 'strategy',
  describe: 'Manage Hyperlane deployment strategies',
  builder: (yargs) =>
    yargs.command(init).command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};

export const init: CommandModuleWithWriteContext<{
  out: string;
}> = {
  command: 'init',
  describe: 'Creates strategy configuration',
  builder: {
    out: outputFileCommandOption(DEFAULT_STRATEGY_CONFIG_PATH),
  },
  handler: async ({ context, out }) => {
    logCommandHeader(`Hyperlane Strategy Init`);

    await createStrategyConfig({
      context,
      outPath: out,
    });
    process.exit(0);
  },
};

export const read: CommandModuleWithWriteContext<{
  strategy: string;
}> = {
  command: 'read',
  describe: 'Reads strategy configuration',
  builder: {
    strategy: {
      ...strategyCommandOption,
      demandOption: true,
      default: DEFAULT_STRATEGY_CONFIG_PATH,
    },
  },
  handler: async ({ strategy: strategyUrl }) => {
    logCommandHeader(`Hyperlane Strategy Read`);

    const strategy = await readChainSubmissionStrategyConfig(strategyUrl);
    const maskedConfig = maskSensitiveData(strategy);
    log(indentYamlOrJson(yamlStringify(maskedConfig, null, 2), 4));

    process.exit(0);
  },
};
