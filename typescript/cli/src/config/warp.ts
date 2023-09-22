import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { TokenType } from '@hyperlane-xyz/hyperlane-token';

import {
  WarpRouteConfig,
  isValidWarpRouteConfig,
  readChainConfigIfExists,
} from '../configs.js';
import { errorRed, logBlue, logGreen } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { FileFormat, writeYamlOrJson } from '../utils/files.js';

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
