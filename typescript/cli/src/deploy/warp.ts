import { confirm, input } from '@inquirer/prompts';

import {
  ChainMap,
  ChainName,
  ConnectionClientConfig,
  EvmTokenAdapter,
  HypERC20Deployer,
  HypERC721Deployer,
  HyperlaneContractsMap,
  MinimalTokenMetadata,
  MultiProtocolProvider,
  MultiProvider,
  RouterConfig,
  TOKEN_TYPE_TO_STANDARD,
  TokenConfig,
  TokenFactories,
  TokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  getTokenConnectionId,
  isCollateralConfig,
  isNativeConfig,
  isSyntheticConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import { isFile, runFileSelectionStep } from '../utils/files.js';

import { completeDeploy, prepareDeploy, runPreflightChecks } from './utils.js';

export async function runWarpRouteDeploy({
  context,
  warpRouteDeploymentConfigPath,
}: {
  context: WriteCommandContext;
  warpRouteDeploymentConfigPath?: string;
}) {
  const { signer, skipConfirmation } = context;

  if (
    !warpRouteDeploymentConfigPath ||
    !isFile(warpRouteDeploymentConfigPath)
  ) {
    if (skipConfirmation)
      throw new Error('Warp route deployment config required');
    warpRouteDeploymentConfigPath = await runFileSelectionStep(
      './configs',
      'Warp route deployment config',
      'warp',
    );
  } else {
    log(
      `Using warp route deployment config at ${warpRouteDeploymentConfigPath}`,
    );
  }
  const warpRouteConfig = readWarpRouteDeployConfig(
    warpRouteDeploymentConfigPath,
  );

  const configs = await runBuildConfigStep({
    context,
    warpRouteConfig,
  });

  const deploymentParams = {
    context,
    ...configs,
  };

  logBlue('Warp route deployment plan');

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecks({
    ...deploymentParams,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();
  const chains = [deploymentParams.origin, ...configs.remotes];

  const initialBalances = await prepareDeploy(context, userAddress, chains);

  await executeDeploy(deploymentParams);

  await completeDeploy(context, 'warp', initialBalances, userAddress, chains);
}

async function runBuildConfigStep({
  context,
  warpRouteConfig,
}: {
  context: WriteCommandContext;
  warpRouteConfig: WarpRouteDeployConfig;
}) {
  const { registry, signer, multiProvider, skipConfirmation } = context;
  log('Assembling token configs');
  const chainAddresses = await registry.getAddresses();
  const owner = await signer.getAddress();
  const requiredRouterFields: Array<keyof ConnectionClientConfig> = ['mailbox'];
  const remotes: string[] = [];

  /// @dev This will keep track of the base collateral metadata which can get overwritten if there are multiple collaterals.
  /// These 'base' variables are used to derive synthetic fields
  /// @todo Remove this artifact when multi-collateral is enabled
  let baseChainName = '';
  let baseMetadata = {} as MinimalTokenMetadata;
  // Define configs that coalesce together values from the config file
  for (const [chain, config] of Object.entries(warpRouteConfig)) {
    // the artifacts, and the SDK as a fallback
    config.owner = owner;
    config.mailbox = config.mailbox || chainAddresses[chain]?.mailbox;
    config.interchainSecurityModule =
      config.interchainSecurityModule ||
      chainAddresses[chain]?.interchainSecurityModule ||
      chainAddresses[chain]?.multisigIsm;
    // config.ismFactory: chainAddresses[baseChainName].domainRoutingIsmFactory, // TODO fix when updating from routingIsm

    if (isCollateralConfig(config) || isNativeConfig(config)) {
      // Store the base metadata
      baseChainName = chain;
      baseMetadata = await fetchBaseTokenMetadata(chain, config, multiProvider);
      log(
        `Using token metadata: Name: ${baseMetadata.name}, Symbol: ${baseMetadata.symbol}, Decimals: ${baseMetadata.decimals}`,
      );
      if (isCollateralConfig(config)) {
        config.name = baseMetadata.name;
        config.symbol = baseMetadata.symbol;
        config.decimals = baseMetadata.decimals;
      }
    } else if (isSyntheticConfig(config)) {
      // Use the config, or baseMetadata
      config.name = config.name || baseMetadata.name;
      config.symbol = config.symbol || baseMetadata.symbol;
      config.totalSupply = config.totalSupply || 0;
      remotes.push(chain);
    }

    let hasShownInfo = false;
    // Request input for any address fields that are missing
    for (const field of requiredRouterFields) {
      if (config[field]) continue;
      if (skipConfirmation)
        throw new Error(`Field ${field} for token on ${chain} required`);
      if (!hasShownInfo) {
        logBlue(
          'Some router fields are missing. Please enter them now, add them to your warp config, or use the --core flag to use deployment artifacts.',
        );
        hasShownInfo = true;
      }
      const value = await input({
        message: `Enter ${field} for ${getTokenName(config)} token on ${chain}`,
      });
      if (!value) throw new Error(`Field ${field} required`);
      config[field] = value.trim();
    }
  }

  log('Token configs ready');
  return {
    configMap: warpRouteConfig,
    origin: baseChainName,
    metadata: baseMetadata,
    remotes,
  };
}

interface DeployParams {
  context: WriteCommandContext;
  configMap: WarpRouteDeployConfig;
  metadata: MinimalTokenMetadata;
  origin: ChainName;
  remotes: ChainName[];
}

async function runDeployPlanStep({
  context,
  configMap,
  origin,
  remotes,
}: DeployParams) {
  const { signer, skipConfirmation } = context;
  const address = await signer.getAddress();
  const baseToken = configMap[origin];

  const baseName = getTokenName(baseToken);
  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Collateral type will be ${baseToken.type}`);
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying a warp route with a base of ${baseName} token on ${origin}`);
  log(`Connecting it to new synthetic tokens on ${remotes.join(', ')}`);
  log(`Using token standard ${configMap.isNft ? 'ERC721' : 'ERC20'}`);

  if (skipConfirmation) return;

  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy(params: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const {
    configMap,
    context: { registry, multiProvider, isDryRun },
  } = params;

  const deployer = configMap.isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider);

  const config = isDryRun
    ? { [params.origin]: configMap[params.origin] }
    : configMap;

  const deployedContracts = await deployer.deploy(
    config as ChainMap<TokenConfig & RouterConfig>,
  ); /// @todo remove ChainMap once Hyperlane deployers are refactored

  logGreen('✅ Hyp token deployments complete');

  if (!isDryRun) log('Writing deployment artifacts');
  const warpCoreConfig = getWarpCoreConfig(params, deployedContracts);
  await registry.addWarpRoute(warpCoreConfig);
  log(JSON.stringify(warpCoreConfig, null, 2));
  logBlue('Deployment is complete!');
}

async function fetchBaseTokenMetadata(
  chain: string,
  config: TokenRouterConfig,
  multiProvider: MultiProvider,
): Promise<MinimalTokenMetadata> {
  if (config.type === TokenType.native) {
    // If it's a native token, use the chain's native token metadata
    const chainNativeToken = multiProvider.getChainMetadata(chain).nativeToken;
    if (chainNativeToken) return chainNativeToken;
    else throw new Error(`No native token metadata for ${chain}`);
  } else if (
    config.type === TokenType.collateralVault ||
    config.type === TokenType.collateral
  ) {
    // If it's a collateral type, use a TokenAdapter to query for its metadata
    log(`Fetching token metadata for ${config.token} on ${chain}`);
    const adapter = new EvmTokenAdapter(
      chain,
      MultiProtocolProvider.fromMultiProvider(multiProvider),
      { token: config.token },
    );
    return adapter.getMetadata();
  } else {
    throw new Error(
      `Unsupported token: ${config.type}. Consider setting token metadata in your deployment config.`,
    );
  }
}

function getTokenName(token: TokenConfig) {
  return token.type === TokenType.native ? 'native' : token.name;
}

function getWarpCoreConfig(
  { configMap, metadata }: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): WarpCoreConfig {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // First pass, create token configs
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = configMap[chainName];
    const collateralAddressOrDenom =
      config.type === TokenType.collateral ? config.token : undefined;
    warpCoreConfig.tokens.push({
      chainName,
      standard: TOKEN_TYPE_TO_STANDARD[config.type],
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      addressOrDenom:
        contract[configMap[chainName].type as keyof TokenFactories].address,
      collateralAddressOrDenom,
    });
  }

  // Second pass, add connections between tokens
  // Assumes full interconnectivity between all tokens for now b.c. that's
  // what the deployers do by default.
  for (const token1 of warpCoreConfig.tokens) {
    for (const token2 of warpCoreConfig.tokens) {
      if (
        token1.chainName === token2.chainName &&
        token1.addressOrDenom === token2.addressOrDenom
      )
        continue;
      token1.connections ||= [];
      token1.connections.push({
        token: getTokenConnectionId(
          ProtocolType.Ethereum,
          token2.chainName,
          token2.addressOrDenom!,
        ),
      });
    }
  }

  return warpCoreConfig;
}
