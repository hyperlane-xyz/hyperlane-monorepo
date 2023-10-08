import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';
import { z } from 'zod';

import { TokenType } from '@hyperlane-xyz/hyperlane-token';

import { errorRed, logBlue, logGreen } from '../../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { FileFormat, readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { readChainConfigIfExists } from './chain.js';

const ConnectionConfigSchema = {
  mailbox: z.string().optional(),
  interchainGasPaymaster: z.string().optional(),
  interchainSecurityModule: z.string().optional(),
  foreignDeployment: z.string().optional(),
};

export const WarpRouteConfigSchema = z.object({
  base: z.object({
    type: z.literal(TokenType.native).or(z.literal(TokenType.collateral)),
    chainName: z.string(),
    address: z.string().optional(),
    isNft: z.boolean().optional(),
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
    ...ConnectionConfigSchema,
  }),
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

type InferredType = z.infer<typeof WarpRouteConfigSchema>;
// A workaround for Zod's terrible typing for nonEmpty arrays
export type WarpRouteConfig = {
  base: InferredType['base'];
  synthetics: Array<InferredType['synthetics'][0]>;
};

export function readWarpRouteConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No warp config found at ${filePath}`);
  const result = WarpRouteConfigSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid warp config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return result.data;
}

export function isValidWarpRouteConfig(config: any) {
  return WarpRouteConfigSchema.safeParse(config).success;
}

export async function createWarpConfig({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new warp route config');
  const customChains = readChainConfigIfExists(chainConfigPath);
  const baseChain = await runSingleChainSelectionStep(
    customChains,
    'Select base chain with the original token to warp',
  );

  const isNative = await confirm({
    message:
      'Are you creating a route for the native token of the base chain (e.g. Ether on Ethereum)?',
  });

  const baseType = isNative ? TokenType.native : TokenType.collateral;
  const baseAddress = isNative
    ? ethers.constants.AddressZero
    : await input({ message: 'Enter the token address' });
  const isNft = isNative
    ? false
    : await confirm({ message: 'Is this an NFT (i.e. ERC-721)?' });

  const syntheticChains = await runMultiChainSelectionStep(
    customChains,
    'Select the chains to which the base token will be connected',
  );

  // TODO add more prompts here to support customizing the token metadata

  const result: WarpRouteConfig = {
    base: {
      chainName: baseChain,
      type: baseType,
      address: baseAddress,
      isNft,
    },
    synthetics: syntheticChains.map((chain) => ({ chainName: chain })),
  };

  if (isValidWarpRouteConfig(result)) {
    logGreen(`Warp Route config is valid, writing to file ${outPath}`);
    writeYamlOrJson(outPath, result, format);
  } else {
    errorRed(
      `Warp config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-tokens.yaml for an example`,
    );
    throw new Error('Invalid multisig config');
  }
}
