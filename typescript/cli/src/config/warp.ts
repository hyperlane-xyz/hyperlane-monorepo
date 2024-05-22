import { input, select } from '@inquirer/prompts';

import {
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen } from '../logger.js';
import {
  detectAndConfirmOrPrompt,
  runMultiChainSelectionStep,
} from '../utils/chains.js';
import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

const TYPE_DESCRIPTIONS: Record<TokenType, string> = {
  [TokenType.synthetic]: 'A new ERC20 with remote transfer functionality',
  [TokenType.collateral]:
    'Extends an existing ERC20 with remote transfer functionality',
  [TokenType.native]:
    'Extends the native token with remote transfer functionality',
  [TokenType.collateralVault]:
    'Extends an existing ERC4626 with remote transfer functionality',
  [TokenType.collateralFiat]:
    'Extends an existing FiatToken with remote transfer functionality',
  [TokenType.collateralXERC20]:
    'Extends an existing xERC20 with Warp Route functionality',
  // TODO: describe
  [TokenType.fastSynthetic]: '',
  [TokenType.syntheticUri]: '',
  [TokenType.fastCollateral]: '',
  [TokenType.collateralUri]: '',
  [TokenType.nativeScaled]: '',
};

const TYPE_CHOICES = Object.values(TokenType).map((type) => ({
  name: type,
  value: type,
  description: TYPE_DESCRIPTIONS[type],
}));

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

  const owner = await detectAndConfirmOrPrompt(
    async () => context.signer?.getAddress(),
    'Enter the desired',
    'owner address',
  );

  const warpChains = await runMultiChainSelectionStep(
    context.chainMetadata,
    'Select chains to connect',
  );

  const result: WarpRouteDeployConfig = {};
  WarpRouteDeployConfigSchema;
  for (const chain of warpChains) {
    logBlue(`Configuring warp route for chain ${chain}`);
    const type = await select({
      message: `Select ${chain}'s token type`,
      choices: TYPE_CHOICES,
    });

    // TODO: restore NFT prompting
    const isNft =
      type === TokenType.syntheticUri || type === TokenType.collateralUri;

    const mailbox = await detectAndConfirmOrPrompt(
      async () => {
        const addresses = await context.registry.getChainAddresses(chain);
        return addresses?.mailbox;
      },
      `For ${chain}, enter the`,
      'mailbox address',
    );

    switch (type) {
      case TokenType.collateral:
      case TokenType.collateralXERC20:
      case TokenType.collateralFiat:
      case TokenType.collateralUri:
      case TokenType.fastCollateral:
      case TokenType.collateralVault:
        result[chain] = {
          mailbox,
          type,
          owner,
          isNft,
          token: await input({
            message: `Enter the existing token address on chain ${chain}`,
          }),
        };
        break;
      default:
        result[chain] = { mailbox, type, owner, isNft };
    }
  }

  try {
    const parsed = WarpRouteDeployConfigSchema.parse(result);
    logGreen(`Warp Route config is valid, writing to file ${outPath}`);
    writeYamlOrJson(outPath, parsed);
  } catch (e) {
    errorRed(
      `Warp route deployment config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-route-deployment.yaml for an example`,
    );
    throw e;
  }
}

// Note, this is different than the function above which reads a config
// for a DEPLOYMENT. This gets a config for using a warp route (aka WarpCoreConfig)
export function readWarpRouteConfig(filePath: string): WarpCoreConfig {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No warp route config found at ${filePath}`);
  return WarpCoreConfigSchema.parse(config);
}
