import { type CommandModule } from 'yargs';

import type { CommandModuleWithWriteContext } from '../context/types.js';
import { deployTransferRouters } from '../deploy/transfer-router.js';
import { logCommandHeader, logGreen } from '../logger.js';
import { parseTransferRouterDeployConfig } from '../transfer-router/types.js';
import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { outputFileCommandOption } from './options.js';

export const transferRouterCommand: CommandModule = {
  command: 'transfer-router',
  describe: 'Manage Hyperlane transfer routers',
  builder: (yargs) => yargs.command(deploy).version(false).demandCommand(),

  handler: () => logGreen('Command required'),
};

export const deploy: CommandModuleWithWriteContext<{
  config: string;
  out: string;
}> = {
  command: 'deploy',
  describe: 'Deploy transfer routers',
  builder: {
    config: {
      type: 'string',
      description: 'Path to transfer router deployment config file',
      demandOption: true,
    },
    out: {
      ...outputFileCommandOption(),
      default: './transfer-router-deployment.yaml',
    },
  },
  handler: async ({ context, config: configPath, out: outPath }) => {
    logCommandHeader('Hyperlane Transfer Router Deployment');

    const configData = readYamlOrJson(configPath);
    const deployConfig = parseTransferRouterDeployConfig(configData);

    const output = await deployTransferRouters({
      config: deployConfig,
      multiProvider: context.multiProvider,
      options: {},
    });

    writeYamlOrJson(outPath, output, 'yaml');
    logGreen(`\nTransfer router deployment output written to ${outPath}`);

    process.exit(0);
  },
};
