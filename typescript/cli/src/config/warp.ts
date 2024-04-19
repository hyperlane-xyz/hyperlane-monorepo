import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';
import { z } from 'zod';

import { TokenType, ZHash } from '@hyperlane-xyz/sdk';

import { errorRed, logBlue, logGreen } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { FileFormat, readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

const ConnectionConfigSchema = {
  mailbox: ZHash.optional(),
  interchainSecurityModule: ZHash.optional(),
  foreignDeployment: z.string().optional(),
};

export const WarpRouteDeployConfigSchema = z.object({
  base: z
    .object({
      type: z
        .literal(TokenType.native)
        .or(z.literal(TokenType.collateral))
        .or(z.literal(TokenType.collateralVault)),
      chainName: z.string(),
      address: ZHash.optional(),
      isNft: z.boolean().optional(),
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimals: z.number().optional(),
      ...ConnectionConfigSchema,
    })
    .refine(
      (data) => {
        // For collateralVault Warp Routes, address will specify the vault
        if (
          data.type === TokenType.collateralVault &&
          data.address === ethers.constants.AddressZero
        )
          return false;

        return true;
      },
      {
        message: 'Vault address is required when type is collateralVault',
        path: ['address'],
      },
    ),
  synthetics: z
    .array(
      z.object({
        chainName: z.string(),
        name: z.string().optional(),
        symbol: z.string().optional(),
        totalSupply: z.number().optional(),
        ...ConnectionConfigSchema,
      }),
    )
    .nonempty(),
});

type InferredType = z.infer<typeof WarpRouteDeployConfigSchema>;
// A workaround for Zod's terrible typing for nonEmpty arrays
export type WarpRouteDeployConfig = {
  base: InferredType['base'];
  synthetics: Array<InferredType['synthetics'][0]>;
};

export function readWarpRouteDeployConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config)
    throw new Error(`No warp route deploy config found at ${filePath}`);
  const result = WarpRouteDeployConfigSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid warp config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return result.data;
}

export function isValidWarpRouteDeployConfig(config: any) {
  return WarpRouteDeployConfigSchema.safeParse(config).success;
}

export async function createWarpRouteDeployConfig({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new warp route deployment config');
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const baseChain = await runSingleChainSelectionStep(
    customChains,
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

  const syntheticChains = await runMultiChainSelectionStep(
    customChains,
    'Select chains to which the base token will be connected',
  );

  // TODO add more prompts here to support customizing the token metadata
  let baseType: TokenType;
  if (isNative) {
    baseType = TokenType.native;
  } else {
    baseType = isYieldBearing
      ? TokenType.collateralVault
      : TokenType.collateral;
  }
  const result: WarpRouteDeployConfig = {
    base: {
      chainName: baseChain,
      type: baseType,
      address: baseAddress,
      isNft,
    },
    synthetics: syntheticChains.map((chain) => ({ chainName: chain })),
  };

  if (isValidWarpRouteDeployConfig(result)) {
    logGreen(`Warp Route config is valid, writing to file ${outPath}`);
    writeYamlOrJson(outPath, result, format);
  } else {
    errorRed(
      `Warp route deployment config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-route-deployment.yaml for an example`,
    );
    throw new Error('Invalid multisig config');
  }
}
