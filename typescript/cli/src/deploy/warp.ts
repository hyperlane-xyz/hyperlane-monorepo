import { confirm, input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ERC20__factory,
  ERC721__factory,
  HypERC20Deployer,
  HypERC721Deployer,
  TokenConfig,
  TokenFactories,
  TokenType,
} from '@hyperlane-xyz/hyperlane-token';
import {
  ChainMap,
  ChainName,
  ConnectionClientConfig,
  HyperlaneContractsMap,
  MultiProvider,
  RouterConfig,
  chainMetadata as defaultChainMetadata,
} from '@hyperlane-xyz/sdk';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { log, logBlue, logGray, logGreen } from '../../logger.js';
import { readDeploymentArtifacts } from '../config/artifacts.js';
import { WarpRouteConfig, readWarpRouteConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_BALANCE } from '../consts.js';
import {
  getContextWithSigner,
  getMergedContractAddresses,
} from '../context.js';
import {
  prepNewArtifactsFiles,
  runFileSelectionStep,
  writeJson,
} from '../utils/files.js';

import { MinimalTokenMetadata, WarpUITokenConfig } from './types.js';
import { runPreflightChecks } from './utils.js';

export async function runWarpDeploy({
  key,
  chainConfigPath,
  warpConfigPath,
  coreArtifactsPath,
  outPath,
  skipConfirmation,
}: {
  key: string;
  chainConfigPath: string;
  warpConfigPath?: string;
  coreArtifactsPath?: string;
  outPath: string;
  skipConfirmation: boolean;
}) {
  const { multiProvider, signer } = getContextWithSigner(key, chainConfigPath);

  if (!warpConfigPath) {
    warpConfigPath = await runFileSelectionStep(
      './configs',
      'Warp config',
      'warp',
    );
  }
  const warpRouteConfig = readWarpRouteConfig(warpConfigPath);

  const artifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

  const configs = await runBuildConfigStep({
    warpRouteConfig,
    artifacts,
    multiProvider,
    signer,
  });

  const deploymentParams = {
    ...configs,
    signer,
    multiProvider,
    outPath,
    skipConfirmation,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecks({
    ...deploymentParams,
    minBalanceWei: MINIMUM_WARP_DEPLOY_BALANCE,
  });
  await executeDeploy(deploymentParams);
}

async function runBuildConfigStep({
  warpRouteConfig,
  multiProvider,
  signer,
  artifacts,
}: {
  warpRouteConfig: WarpRouteConfig;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  artifacts?: HyperlaneContractsMap<any>;
}) {
  log('Assembling token configs');
  const { base, synthetics } = warpRouteConfig;
  const { type: baseType, chainName: baseChainName, isNft } = base;

  const owner = await signer.getAddress();

  const baseMetadata = await fetchBaseTokenMetadata(base, multiProvider);
  log(
    `Using base token metadata: Name: ${baseMetadata.name}, Symbol: ${baseMetadata.symbol}, Decimals: ${baseMetadata.decimals}`,
  );

  const mergedContractAddrs = getMergedContractAddresses(artifacts);

  // Create configs that coalesce together values from the config file,
  // the artifacts, and the SDK as a fallback
  const configMap: ChainMap<TokenConfig & RouterConfig> = {
    [baseChainName]: {
      type: baseType,
      token:
        baseType === TokenType.collateral
          ? base.address!
          : ethers.constants.AddressZero,
      owner,
      mailbox: base.mailbox || mergedContractAddrs[baseChainName].mailbox,
      interchainSecurityModule:
        base.interchainSecurityModule ||
        mergedContractAddrs[baseChainName].interchainSecurityModule ||
        mergedContractAddrs[baseChainName].multisigIsm,
      interchainGasPaymaster:
        base.interchainGasPaymaster ||
        mergedContractAddrs[baseChainName].defaultIsmInterchainGasPaymaster,
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
        mergedContractAddrs[sChainName].interchainSecurityModule ||
        mergedContractAddrs[sChainName].multisigIsm,
      interchainGasPaymaster:
        synthetic.interchainGasPaymaster ||
        mergedContractAddrs[sChainName].defaultIsmInterchainGasPaymaster,
      foreignDeployment: synthetic.foreignDeployment,
    };
  }

  // Request input for any address fields that are missing
  const requiredRouterFields: Array<keyof ConnectionClientConfig> = [
    'mailbox',
    'interchainSecurityModule',
    'interchainGasPaymaster',
  ];
  let hasShownInfo = false;
  for (const [chain, token] of Object.entries(configMap)) {
    for (const field of requiredRouterFields) {
      if (token[field]) continue;
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
    { filename: 'warp-deployment', description: 'Contract addresses' },
    { filename: 'warp-ui-token-config', description: 'Warp UI token config' },
  ]);

  const deployer = isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider);

  const deployedContracts = await deployer.deploy(configMap);
  logGreen('Hyp token deployments complete');

  log('Writing deployment artifacts');
  writeTokenDeploymentArtifacts(contractsFilePath, deployedContracts, params);
  writeWarpUiTokenConfig(tokenConfigPath, deployedContracts, params);

  logBlue('Deployment is complete!');
  logBlue(`Contract address artifacts are in ${contractsFilePath}`);
  logBlue(`Warp UI token config is in ${tokenConfigPath}`);
}

// TODO move into token classes in the SDK
async function fetchBaseTokenMetadata(
  base: WarpRouteConfig['base'],
  multiProvider: MultiProvider,
): Promise<MinimalTokenMetadata> {
  const { type, name, symbol, chainName, address, decimals, isNft } = base;

  // Skip fetching metadata if it's already provided in the config
  if (name && symbol && decimals) {
    return { name, symbol, decimals };
  }

  if (type === TokenType.native) {
    return (
      multiProvider.getChainMetadata(base.chainName).nativeToken ||
      defaultChainMetadata.ethereum.nativeToken!
    );
  } else if (base.type === TokenType.collateral && address) {
    log(`Fetching token metadata for ${address} on ${chainName}}`);
    const provider = multiProvider.getProvider(chainName);
    if (isNft) {
      const erc721Contract = ERC721__factory.connect(address, provider);
      const [name, symbol] = await Promise.all([
        erc721Contract.name(),
        erc721Contract.symbol(),
      ]);
      return { name, symbol, decimals: 0 };
    } else {
      const erc20Contract = ERC20__factory.connect(address, provider);
      const [name, symbol, decimals] = await Promise.all([
        erc20Contract.name(),
        erc20Contract.symbol(),
        erc20Contract.decimals(),
      ]);
      return { name, symbol, decimals };
    }
  } else {
    throw new Error(`Unsupported token: ${base}`);
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
      router: contract.router.address,
      tokenType: configMap[chain].type,
    };
  });
  writeJson(filePath, artifacts);
}

function writeWarpUiTokenConfig(
  filePath: string,
  contracts: HyperlaneContractsMap<TokenFactories>,
  { configMap, isNft, metadata, origin, multiProvider }: DeployParams,
) {
  const baseConfig = configMap[origin];
  const hypTokenAddr =
    contracts[origin]?.router?.address || configMap[origin]?.foreignDeployment;
  if (!hypTokenAddr) {
    throw Error(
      'No base Hyperlane token address deployed and no foreign deployment specified',
    );
  }
  const commonFields = {
    chainId: multiProvider.getChainId(origin),
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
  };
  let tokenConfig: WarpUITokenConfig;
  if (baseConfig.type === TokenType.collateral) {
    tokenConfig = {
      ...commonFields,
      type: TokenType.collateral,
      address: baseConfig.token,
      hypCollateralAddress: hypTokenAddr,
      isNft,
    };
  } else if (baseConfig.type === TokenType.native) {
    tokenConfig = {
      ...commonFields,
      type: TokenType.native,
      hypNativeAddress: hypTokenAddr,
    };
  } else {
    throw new Error(`Unsupported token type: ${baseConfig.type}`);
  }

  writeJson(filePath, tokenConfig);
}
