import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMetadata,
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { objFilter } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

export function readWarpRouteDeployConfig(
  filePath: string,
): WarpRouteDeployConfig {
  const config = readYamlOrJson(filePath);
  if (!config)
    throw new Error(`No warp route deploy config found at ${filePath}`);
  return WarpRouteDeployConfigSchema.parse(config);
}

export function isValidWarpRouteDeployConfig(config: any) {
  return WarpRouteDeployConfigSchema.safeParse(config).success;
}

export async function createWarpRouteDeployConfig({
  context,
  outPath,
}: {
  context: CommandContext;
  outPath: string;
}) {
  logBlue('Creating a new warp route deployment config');
  const baseChain = await runSingleChainSelectionStep(
    context.chainMetadata,
    'Select base chain with the original token to warp',
  );

  const isNative = await confirm({
    message:
      'Are you creating a route for the native token of the base chain (e.g. Ether on Ethereum)?',
  });

  const isNft = isNative
    ? false
    : await confirm({ message: 'Is this an NFT (i.e. ERC-721)?' });
  const isYieldBearing =
    isNative || isNft
      ? false
      : await confirm({
          message:
            'Do you want this warp route to be yield-bearing (i.e. deposits into ERC-4626 vault)?',
        });

  const addressMessage = `Enter the ${
    isYieldBearing ? 'ERC-4626 vault' : 'collateral token'
  } address`;
  const baseAddress = isNative
    ? ethers.constants.AddressZero
    : await input({ message: addressMessage });

  const metadataWithoutBase = objFilter(
    context.chainMetadata,
    (chain, _): _ is ChainMetadata => chain !== baseChain,
  );
  const syntheticChains = await runMultiChainSelectionStep(
    metadataWithoutBase,
    'Select chains to which the base token will be connected',
  );

  // TODO add more prompts here to support customizing the token metadata
  let result: WarpRouteDeployConfig;
  if (isNative) {
    result = {
      [baseChain]: {
        type: TokenType.native,
      },
    };
  } else {
    result = {
      [baseChain]: {
        type: isYieldBearing ? TokenType.collateralVault : TokenType.collateral,
        token: baseAddress,
        isNft,
      },
    };
  }

  syntheticChains.map((chain) => {
    result[chain] = {
      type: TokenType.synthetic,
    };
  });

  if (isValidWarpRouteDeployConfig(result)) {
    logGreen(`Warp Route config is valid, writing to file ${outPath}`);
    writeYamlOrJson(outPath, result);
  } else {
    errorRed(
      `Warp route deployment config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-route-deployment.yaml for an example`,
    );
    throw new Error('Invalid multisig config');
  }
}

// Note, this is different than the function above which reads a config
// for a DEPLOYMENT. This gets a config for using a warp route (aka WarpCoreConfig)
export function readWarpRouteConfig(filePath: string): WarpCoreConfig {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No warp route config found at ${filePath}`);
  return WarpCoreConfigSchema.parse(config);
}
