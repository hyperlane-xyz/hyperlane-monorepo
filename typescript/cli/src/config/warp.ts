import { confirm, input, select } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainMap,
  DeployedOwnableConfig,
  IsmConfig,
  IsmType,
  MailboxClientConfig,
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  isAddress,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';
import {
  detectAndConfirmOrPrompt,
  setProxyAdminConfig,
} from '../utils/input.js';

import { createAdvancedIsmConfig } from './ism.js';

const TYPE_DESCRIPTIONS: Record<TokenType, string> = {
  [TokenType.synthetic]: 'A new ERC20 with remote transfer functionality',
  [TokenType.syntheticRebase]: `A rebasing ERC20 with remote transfer functionality. Must be paired with ${TokenType.collateralVaultRebase}`,
  [TokenType.collateral]:
    'Extends an existing ERC20 with remote transfer functionality',
  [TokenType.native]:
    'Extends the native token with remote transfer functionality',
  [TokenType.collateralVault]:
    'Extends an existing ERC4626 with remote transfer functionality. Yields are manually claimed by owner.',
  [TokenType.collateralVaultRebase]:
    'Extends an existing ERC4626 with remote transfer functionality. Rebases yields to token holders.',
  [TokenType.collateralFiat]:
    'Extends an existing FiatToken with remote transfer functionality',
  [TokenType.XERC20]:
    'Extends an existing xERC20 with Warp Route functionality',
  [TokenType.XERC20Lockbox]:
    'Extends an existing xERC20 Lockbox with Warp Route functionality',
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

async function fillDefaults(
  context: CommandContext,
  config: ChainMap<Partial<MailboxClientConfig>>,
): Promise<ChainMap<MailboxClientConfig>> {
  return promiseObjAll(
    objMap(config, async (chain, config): Promise<MailboxClientConfig> => {
      let mailbox = config.mailbox;
      if (!mailbox) {
        const addresses = await context.registry.getChainAddresses(chain);
        assert(addresses, `No addresses found for chain ${chain}`);
        mailbox = addresses.mailbox;
      }
      let owner = config.owner;
      if (!owner) {
        owner =
          context.signerAddress ??
          (await context.multiProvider.getSignerAddress(chain));
      }
      return {
        owner,
        mailbox,
        ...config,
      };
    }),
  );
}

export async function readWarpRouteDeployConfig(
  filePath: string,
  context?: CommandContext,
): Promise<WarpRouteDeployConfig> {
  let config = readYamlOrJson(filePath);
  if (!config)
    throw new Error(`No warp route deploy config found at ${filePath}`);
  if (context) {
    config = await fillDefaults(context, config as any);
  }
  return WarpRouteDeployConfigSchema.parse(config);
}

export function isValidWarpRouteDeployConfig(config: any) {
  return WarpRouteDeployConfigSchema.safeParse(config).success;
}

export async function createWarpRouteDeployConfig({
  context,
  outPath,
  advanced = false,
}: {
  context: CommandContext;
  outPath: string;
  advanced: boolean;
}) {
  logBlue('Creating a new warp route deployment config...');

  const warpChains = await runMultiChainSelectionStep({
    chainMetadata: context.chainMetadata,
    message: 'Select chains to connect',
    requireNumber: 1,
    // If the user supplied the --yes flag we skip asking selection
    // confirmation
    requiresConfirmation: !context.skipConfirmation,
  });

  const result: WarpRouteDeployConfig = {};
  let typeChoices = TYPE_CHOICES;
  for (const chain of warpChains) {
    logBlue(`${chain}: Configuring warp route...`);
    const owner = await detectAndConfirmOrPrompt(
      async () => context.signerAddress,
      'Enter the desired',
      'owner address',
      'signer',
    );

    // default to the mailbox from the registry and if not found ask to the user to submit one
    const chainAddresses = await context.registry.getChainAddresses(chain);

    const mailbox =
      chainAddresses?.mailbox ??
      (await input({
        validate: isAddress,
        message: `Could not retrieve mailbox address from the registry for chain "${chain}". Please enter a valid mailbox address:`,
      }));

    const proxyAdmin: DeployedOwnableConfig | undefined =
      await setProxyAdminConfig(context, chain);

    /**
     * The logic from the cli is as follows:
     *  --yes flag is provided: set ism to undefined (default ISM config)
     *  --advanced flag is provided: the user will have to build their own configuration using the available ISM types
     *  -- no flag is provided: the user must choose if the default ISM config should be used:
     *    - yes: the default ISM config will be used (Trusted ISM + Default fallback ISM)
     *    - no: keep ism as undefined (default ISM config)
     */
    let interchainSecurityModule: IsmConfig | undefined;
    if (context.skipConfirmation) {
      interchainSecurityModule = undefined;
    } else if (advanced) {
      interchainSecurityModule = await createAdvancedIsmConfig(context);
    } else if (
      await confirm({
        message: 'Do you want to use a trusted ISM for warp route?',
      })
    ) {
      interchainSecurityModule = createDefaultWarpIsmConfig(owner);
    }

    const type = await select({
      message: `Select ${chain}'s token type`,
      choices: typeChoices,
    });

    // TODO: restore NFT prompting
    const isNft =
      type === TokenType.syntheticUri || type === TokenType.collateralUri;

    switch (type) {
      case TokenType.collateral:
      case TokenType.XERC20:
      case TokenType.XERC20Lockbox:
      case TokenType.collateralFiat:
      case TokenType.collateralUri:
      case TokenType.fastCollateral:
        result[chain] = {
          mailbox,
          type,
          owner,
          proxyAdmin,
          isNft,
          interchainSecurityModule,
          token: await input({
            message: `Enter the existing token address on chain ${chain}`,
          }),
        };
        break;
      case TokenType.syntheticRebase:
        result[chain] = {
          mailbox,
          type,
          owner,
          isNft,
          proxyAdmin,
          collateralChainName: '', // This will be derived correctly by zod.parse() below
          interchainSecurityModule,
        };
        typeChoices = restrictChoices([
          TokenType.syntheticRebase,
          TokenType.collateralVaultRebase,
        ]);
        break;
      case TokenType.collateralVaultRebase:
        result[chain] = {
          mailbox,
          type,
          owner,
          proxyAdmin,
          isNft,
          interchainSecurityModule,
          token: await input({
            message: `Enter the ERC-4626 vault address on chain ${chain}`,
          }),
        };

        typeChoices = restrictChoices([TokenType.syntheticRebase]);
        break;
      case TokenType.collateralVault:
        result[chain] = {
          mailbox,
          type,
          owner,
          proxyAdmin,
          isNft,
          interchainSecurityModule,
          token: await input({
            message: `Enter the ERC-4626 vault address on chain ${chain}`,
          }),
        };
        break;
      default:
        result[chain] = {
          mailbox,
          type,
          owner,
          proxyAdmin,
          isNft,
          interchainSecurityModule,
        };
    }
  }

  try {
    const warpRouteDeployConfig = WarpRouteDeployConfigSchema.parse(result);
    logBlue(`Warp Route config is valid, writing to file ${outPath}:\n`);
    log(indentYamlOrJson(yamlStringify(warpRouteDeployConfig, null, 2), 4));
    writeYamlOrJson(outPath, warpRouteDeployConfig, 'yaml');
    logGreen('✅ Successfully created new warp route deployment config.');
  } catch (e) {
    errorRed(
      `Warp route deployment config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-route-deployment.yaml for an example.`,
    );
    throw e;
  }
}

function restrictChoices(typeChoices: TokenType[]) {
  return TYPE_CHOICES.filter((choice) => typeChoices.includes(choice.name));
}

// Note, this is different than the function above which reads a config
// for a DEPLOYMENT. This gets a config for using a warp route (aka WarpCoreConfig)
export function readWarpCoreConfig(filePath: string): WarpCoreConfig {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No warp route config found at ${filePath}`);
  return WarpCoreConfigSchema.parse(config);
}

/**
 * Creates a default configuration for an ISM with a TRUSTED_RELAYER and FALLBACK_ROUTING.
 *
 * Properties relayer and owner are both set as input owner.
 *
 * @param owner - The address of the owner of the ISM.
 * @returns The default Aggregation ISM configuration.
 */
function createDefaultWarpIsmConfig(owner: Address): IsmConfig {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      {
        type: IsmType.TRUSTED_RELAYER,
        relayer: owner,
      },
      createFallbackRoutingConfig(owner),
    ],
    threshold: 1,
  };
}

/**
 * Creates a fallback configuration for an ISM with a FALLBACK_ROUTING and the provided `owner`.
 *
 * @param owner - The address of the owner of the ISM.
 * @returns The Fallback Routing ISM configuration.
 */
function createFallbackRoutingConfig(owner: Address): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner,
  };
}
