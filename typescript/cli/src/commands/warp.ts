import { ethers } from 'ethers';
import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IXERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  EvmERC20WarpRouteReader,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import {
  createWarpRouteDeployConfig,
  readWarpCoreConfig,
} from '../config/warp.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logGray, logGreen, logRed } from '../logger.js';
import { sendTestTransfer } from '../send/transfer.js';
import { indentYamlOrJson, writeYamlOrJson } from '../utils/files.js';
import { selectRegistryWarpRoute } from '../utils/tokens.js';

import {
  addressCommandOption,
  chainCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  outputFileCommandOption,
  symbolCommandOption,
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
      .command(deploy)
      .command(init)
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

export const init: CommandModuleWithContext<{
  advanced: boolean;
  out: string;
}> = {
  command: 'init',
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
  describe: 'Derive the warp route config from onchain artifacts',
  builder: {
    symbol: {
      ...symbolCommandOption,
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
    // logGray('Hyperlane Warp Reader');
    // logGray('---------------------');

    const { multiProvider } = context;

    let addresses: ChainMap<string>;
    if (symbol) {
      const warpCoreConfig = await selectRegistryWarpRoute(
        context.registry,
        symbol,
      );

      const limits = Object.fromEntries(
        await Promise.all(
          warpCoreConfig.tokens.map(async (t) => {
            let xerc20Address: string;
            switch (t.standard) {
              case 'EvmHypXERC20Lockbox':
                xerc20Address = await HypXERC20Lockbox__factory.connect(
                  t.addressOrDenom!,
                  multiProvider.getProvider(t.chainName),
                ).xERC20();
                break;
              case 'EvmHypXERC20':
                xerc20Address = await HypXERC20__factory.connect(
                  t.addressOrDenom!,
                  multiProvider.getProvider(t.chainName),
                ).wrappedToken();
                break;
              default:
                throw new Error('not xerc20');
            }
            const xerc20 = IXERC20__factory.connect(
              xerc20Address,
              multiProvider.getProvider(t.chainName),
            );
            const mintLimit = await xerc20.mintingCurrentLimitOf(
              t.addressOrDenom!,
            );
            const burnLimit = await xerc20.burningCurrentLimitOf(
              t.addressOrDenom!,
            );

            return [
              t.chainName,
              {
                mintLimit: ethers.utils.formatEther(mintLimit),
                burnLimit: ethers.utils.formatEther(burnLimit),
              },
            ];
          }),
        ),
      );
      console.log(JSON.stringify(limits));
      return;

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
    warp?: string;
    symbol?: string;
    router?: string;
    amount: string;
    recipient?: string;
  }
> = {
  command: 'send',
  describe: 'Send a test token transfer on a warp route',
  builder: {
    ...messageOptions,
    symbol: {
      ...symbolCommandOption,
      demandOption: false,
    },
    warp: {
      ...warpCoreConfigCommandOption,
      demandOption: false,
    },
    amount: {
      type: 'string',
      description: 'Amount to send (in smallest unit)',
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
    symbol,
    warp,
    amount,
    recipient,
  }) => {
    let warpCoreConfig: WarpCoreConfig;
    if (symbol) {
      warpCoreConfig = await selectRegistryWarpRoute(context.registry, symbol);
    } else if (warp) {
      warpCoreConfig = readWarpCoreConfig(warp);
    } else {
      logRed(`Please specify either a symbol or warp config`);
      process.exit(0);
    }

    await sendTestTransfer({
      context,
      warpCoreConfig,
      origin,
      destination,
      amount,
      recipient,
      timeoutSec: timeout,
      skipWaitForDelivery: quick,
      selfRelay: relay,
    });
    process.exit(0);
  },
};
