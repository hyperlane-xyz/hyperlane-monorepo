import { type CommandModule } from 'yargs';

import { assert } from '@hyperlane-xyz/utils';

import type { CommandModuleWithWriteContext } from '../context/types.js';
import { deployTransferRouters } from '../deploy/transfer-router.js';
import { logCommandHeader, logGreen } from '../logger.js';
import {
  parseTransferRouterDeployConfig,
  TransferRouterOutputSchema,
} from '../transfer-router/types.js';
import { executeTransferRouterTransfer } from '../transfer-router/transfer.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';
import { isFile, readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  outputFileCommandOption,
  transferRouterIdCommandOption,
  warpRouteIdCommandOption,
} from './options.js';

export const transferRouterCommand: CommandModule = {
  command: 'transfer-router',
  describe: 'Manage Hyperlane transfer routers',
  builder: (yargs) =>
    yargs.command(deploy).command(transfer).version(false).demandCommand(),

  handler: () => logGreen('Command required'),
};

export const deploy: CommandModuleWithWriteContext<{
  config?: string;
  transferRouterId?: string;
  out: string;
}> = {
  command: 'deploy',
  describe: 'Deploy transfer routers',
  builder: {
    config: {
      type: 'string',
      description: 'Path to transfer router deployment config file',
    },
    'transfer-router-id': transferRouterIdCommandOption,
    out: {
      ...outputFileCommandOption(),
      default: './transfer-router-deployment.yaml',
    },
  },
  handler: async ({
    context,
    config: configPath,
    transferRouterId,
    out: outPath,
  }) => {
    logCommandHeader('Hyperlane Transfer Router Deployment');

    assert(
      configPath || transferRouterId,
      'Must provide either --config or --transfer-router-id',
    );

    let resolvedConfigPath: string;
    if (configPath) {
      resolvedConfigPath = configPath;
    } else {
      // Resolve from registry: deployments/transfer_router/<id>-deploy.yaml
      resolvedConfigPath = context.registry.getUri(
        `deployments/transfer_router/${transferRouterId}-deploy.yaml`,
      );
    }

    assert(
      isFile(resolvedConfigPath),
      `Transfer router deploy config not found at ${resolvedConfigPath}`,
    );

    const configData = readYamlOrJson(resolvedConfigPath);
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

export const transfer: CommandModuleWithWriteContext<{
  config: string;
  warpRouteId?: string;
  origin: string;
  destination: string;
  amount: string;
  recipient?: string;
}> = {
  command: 'transfer',
  describe: 'Transfer tokens via transfer router',
  builder: {
    config: {
      type: 'string',
      description: 'Path to transfer router deployment output YAML',
      demandOption: true,
    },
    'warp-route-id': {
      ...warpRouteIdCommandOption,
      demandOption: false,
    },
    origin: {
      type: 'string',
      description: 'Origin chain name',
      demandOption: true,
    },
    destination: {
      type: 'string',
      description: 'Destination chain name',
      demandOption: true,
    },
    amount: {
      type: 'string',
      description: 'Amount to transfer in smallest unit',
      demandOption: true,
    },
    recipient: {
      type: 'string',
      description: 'Recipient address (defaults to signer address)',
      demandOption: false,
    },
  },
  handler: async ({
    context,
    config: configPath,
    warpRouteId,
    origin,
    destination,
    amount,
    recipient,
  }) => {
    logCommandHeader('Hyperlane Transfer Router Transfer');

    assert(
      isFile(configPath),
      `Transfer router config not found at ${configPath}`,
    );

    const transferRouterConfig = TransferRouterOutputSchema.parse(
      readYamlOrJson(configPath),
    );
    const warpCoreConfig = await getWarpCoreConfigOrExit({
      context,
      warpRouteId,
    });

    await executeTransferRouterTransfer({
      context,
      transferRouterConfig,
      warpCoreConfig,
      origin,
      destination,
      amount,
      recipient,
    });

    process.exit(0);
  },
};
