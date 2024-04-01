import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

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
  TokenType,
  WarpCoreConfig,
  getTokenConnectionId,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, objMap } from '@hyperlane-xyz/utils';

import {
  WarpRouteDeployConfig,
  readWarpRouteDeployConfig,
} from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { getContext, getMergedContractAddresses } from '../context.js';
import { log, logBlue, logGray, logGreen } from '../logger.js';
import {
  isFile,
  prepNewArtifactsFiles,
  runFileSelectionStep,
  writeJson,
} from '../utils/files.js';

import { runPreflightChecks } from './utils.js';

export async function runWarpRouteDeploy({
  key,
  chainConfigPath,
  warpRouteDeploymentConfigPath,
  coreArtifactsPath,
  outPath,
  skipConfirmation,
}: {
  key: string;
  chainConfigPath: string;
  warpRouteDeploymentConfigPath?: string;
  coreArtifactsPath?: string;
  outPath: string;
  skipConfirmation: boolean;
}) {
  const { multiProvider, signer, coreArtifacts } = await getContext({
    chainConfigPath,
    coreConfig: { coreArtifactsPath },
    keyConfig: { key },
    skipConfirmation,
  });

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
    warpRouteConfig,
    coreArtifacts,
    multiProvider,
    signer,
    skipConfirmation,
  });

  const deploymentParams = {
    ...configs,
    signer,
    multiProvider,
    outPath,
    skipConfirmation,
  };

  logBlue('Warp route deployment plan');

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecks({
    ...deploymentParams,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });
  await executeDeploy(deploymentParams);
}

async function runBuildConfigStep({
  warpRouteConfig,
  multiProvider,
  signer,
  coreArtifacts,
  skipConfirmation,
}: {
  warpRouteConfig: WarpRouteDeployConfig;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  coreArtifacts?: HyperlaneContractsMap<any>;
  skipConfirmation: boolean;
}) {
  log('Assembling token configs');
  const { base, synthetics } = warpRouteConfig;
  const { type: baseType, chainName: baseChainName, isNft } = base;

  const owner = await signer.getAddress();
  const baseMetadata = await fetchBaseTokenMetadata(base, multiProvider);

  log(
    `Using base token metadata: Name: ${baseMetadata.name}, Symbol: ${baseMetadata.symbol}, Decimals: ${baseMetadata.decimals}`,
  );

  const mergedContractAddrs = getMergedContractAddresses(
    coreArtifacts,
    Object.keys(warpRouteConfig),
  );

  // Create configs that coalesce together values from the config file,
  // the artifacts, and the SDK as a fallback
  const configMap: ChainMap<TokenConfig & RouterConfig> = {
    [baseChainName]: {
      type: baseType,
      token:
        baseType === TokenType.collateral ||
        baseType === TokenType.collateralVault
          ? base.address!
          : ethers.constants.AddressZero,
      owner,
      mailbox: base.mailbox || mergedContractAddrs[baseChainName]?.mailbox,
      interchainSecurityModule:
        base.interchainSecurityModule ||
        mergedContractAddrs[baseChainName]?.interchainSecurityModule ||
        mergedContractAddrs[baseChainName]?.multisigIsm,
      // ismFactory: mergedContractAddrs[baseChainName].domainRoutingIsmFactory, // TODO fix when updating from routingIsm
      foreignDeployment: base.foreignDeployment,
      name: baseMetadata.name,
      symbol: baseMetadata.symbol,
      decimals: baseMetadata.decimals,
    },
  };

  for (const synthetic of synthetics) {
    const sChainName = synthetic.chainName;
    configMap[sChainName] = {
      type: TokenType.synthetic,
      name: synthetic.name || baseMetadata.name,
      symbol: synthetic.symbol || baseMetadata.symbol,
      totalSupply: synthetic.totalSupply || 0,
      owner,
      mailbox: synthetic.mailbox || mergedContractAddrs[sChainName].mailbox,
      interchainSecurityModule:
        synthetic.interchainSecurityModule ||
        mergedContractAddrs[sChainName]?.interchainSecurityModule ||
        mergedContractAddrs[sChainName]?.multisigIsm,
      // ismFactory: mergedContractAddrs[sChainName].domainRoutingIsmFactory, // TODO fix
      foreignDeployment: synthetic.foreignDeployment,
    };
  }

  // Request input for any address fields that are missing
  const requiredRouterFields: Array<keyof ConnectionClientConfig> = ['mailbox'];
  let hasShownInfo = false;
  for (const [chain, token] of Object.entries(configMap)) {
    for (const field of requiredRouterFields) {
      if (token[field]) continue;
      if (skipConfirmation)
        throw new Error(`Field ${field} for token on ${chain} required`);
      if (!hasShownInfo) {
        logBlue(
          'Some router fields are missing. Please enter them now, add them to your warp config, or use the --core flag to use deployment artifacts.',
        );
        hasShownInfo = true;
      }
      const value = await input({
        message: `Enter ${field} for ${getTokenName(token)} token on ${chain}`,
      });
      if (!value) throw new Error(`Field ${field} required`);
      token[field] = value.trim();
    }
  }

  log('Token configs ready');
  return {
    configMap,
    metadata: baseMetadata,
    origin: baseChainName,
    remotes: synthetics.map(({ chainName }) => chainName),
    isNft: !!isNft,
  };
}

interface DeployParams {
  configMap: ChainMap<TokenConfig & RouterConfig>;
  isNft: boolean;
  metadata: MinimalTokenMetadata;
  origin: ChainName;
  remotes: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  outPath: string;
  skipConfirmation: boolean;
}

async function runDeployPlanStep({
  configMap,
  isNft,
  origin,
  remotes,
  signer,
  skipConfirmation,
}: DeployParams) {
  const address = await signer.getAddress();
  const baseToken = configMap[origin];
  const baseName = getTokenName(baseToken);
  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Collateral type will be ${baseToken.type}`);
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying a warp route with a base of ${baseName} token on ${origin}`);
  log(`Connecting it to new synthetic tokens on ${remotes.join(', ')}`);
  log(`Using token standard ${isNft ? 'ERC721' : 'ERC20'}`);

  if (skipConfirmation) return;

  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy(params: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const { configMap, isNft, multiProvider, outPath } = params;

  const [contractsFilePath, tokenConfigPath] = prepNewArtifactsFiles(outPath, [
    { filename: 'warp-route-deployment', description: 'Contract addresses' },
    { filename: 'warp-config', description: 'Warp config' },
  ]);

  const deployer = isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider);

  const deployedContracts = await deployer.deploy(configMap);
  logGreen('Hyp token deployments complete');

  log('Writing deployment artifacts');
  writeTokenDeploymentArtifacts(contractsFilePath, deployedContracts, params);
  writeWarpConfig(tokenConfigPath, deployedContracts, params);

  logBlue('Deployment is complete!');
  logBlue(`Contract address artifacts are in ${contractsFilePath}`);
  logBlue(`Warp config is in ${tokenConfigPath}`);
}

async function fetchBaseTokenMetadata(
  base: WarpRouteDeployConfig['base'],
  multiProvider: MultiProvider,
): Promise<MinimalTokenMetadata> {
  const { type, name, symbol, chainName, address, decimals } = base;

  // Skip fetching metadata if it's already provided in the config
  if (name && symbol && decimals) {
    return { name, symbol, decimals };
  }

  if (type === TokenType.native) {
    // If it's a native token, use the chain's native token metadata
    const chainNativeToken =
      multiProvider.getChainMetadata(chainName).nativeToken;
    if (chainNativeToken) return chainNativeToken;
    else throw new Error(`No native token metadata for ${chainName}`);
  } else if (
    base.type === TokenType.collateralVault ||
    (base.type === TokenType.collateral && address)
  ) {
    // If it's a collateral type, use a TokenAdapter to query for its metadata
    log(`Fetching token metadata for ${address} on ${chainName}`);
    const adapter = new EvmTokenAdapter(
      chainName,
      MultiProtocolProvider.fromMultiProvider(multiProvider),
      { token: address as string },
    );
    return adapter.getMetadata();
  } else {
    throw new Error(
      `Unsupported token: ${base.type}. Consider setting token metadata in your deployment config.`,
    );
  }
}

function getTokenName(token: TokenConfig) {
  return token.type === TokenType.native ? 'native' : token.name;
}
function writeTokenDeploymentArtifacts(
  filePath: string,
  contracts: HyperlaneContractsMap<TokenFactories>,
  { configMap }: DeployParams,
) {
  const artifacts: ChainMap<{
    router: Address;
    tokenType: TokenType;
  }> = objMap(contracts, (chain, contract) => {
    return {
      router: contract[configMap[chain].type as keyof TokenFactories].address,
      tokenType: configMap[chain].type,
    };
  });
  writeJson(filePath, artifacts);
}

function writeWarpConfig(
  filePath: string,
  contracts: HyperlaneContractsMap<TokenFactories>,
  { configMap, metadata }: DeployParams,
) {
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

  writeJson(filePath, warpCoreConfig);
}
