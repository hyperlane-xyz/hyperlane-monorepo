import { confirm } from '@inquirer/prompts';

import {
  EvmERC20WarpModule,
  HypERC20Deployer,
  HyperlaneContractsMap,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  attachContractsMap,
  getTokenConnectionId,
  hypERC20factories,
  isTokenMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen, logTable } from '../logger.js';
import { isFile, runFileSelectionStep } from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runPreflightChecksForChains,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  configMap: WarpRouteDeployConfig;
}

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
  const warpRouteConfig = await readWarpRouteDeployConfig(
    warpRouteDeploymentConfigPath,
    context,
  );

  const deploymentParams = {
    context,
    configMap: warpRouteConfig,
  };

  logBlue('Warp route deployment plan');

  await runDeployPlanStep(deploymentParams);
  const chains = Object.keys(warpRouteConfig);

  await runPreflightChecksForChains({
    context,
    chains,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, chains);

  await executeDeploy(deploymentParams);

  await completeDeploy(context, 'warp', initialBalances, userAddress, chains);
}

async function runDeployPlanStep({ context, configMap }: DeployParams) {
  const { skipConfirmation } = context;

  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Using token standard ${configMap.isNft ? 'ERC721' : 'ERC20'}`);
  logTable(configMap);

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
    context: { registry, multiProvider, isDryRun, dryRunChain },
  } = params;

  const warpDeployconfig: WarpRouteDeployConfig =
    isDryRun && dryRunChain
      ? { [dryRunChain]: configMap[dryRunChain] }
      : configMap;

  const deployedAddressesMap = await promiseObjAll(
    objMap(warpDeployconfig, async (chain, config) => {
      const evmERC20WarpModule = await EvmERC20WarpModule.create({
        chain,
        config,
        multiProvider,
      });

      return evmERC20WarpModule.serialize();
    }),
  );
  logGreen('✅ Hyp token deployments complete');

  const deployedContractMap = attachContractsMap(
    deployedAddressesMap,
    hypERC20factories,
  );

  const warpCoreConfig = await getWarpCoreConfig(params, deployedContractMap);
  if (!isDryRun) {
    log('Writing deployment artifacts');
    await registry.addWarpRoute(warpCoreConfig);
  }
  log(JSON.stringify(warpCoreConfig, null, 2));
  logBlue('Deployment is complete!');
}

async function getWarpCoreConfig(
  { configMap, context }: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): Promise<WarpCoreConfig> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    context.multiProvider,
    configMap,
  );

  // First pass, create token configs
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = configMap[chainName];
    const metadata = {
      ...tokenMetadata,
      ...config,
    };

    if (!isTokenMetadata(metadata)) {
      throw new Error('Missing required token metadata');
    }

    const { decimals } = metadata;
    if (!decimals) {
      throw new Error('Missing decimals on token metadata');
    }

    const collateralAddressOrDenom =
      config.type === TokenType.collateral ? config.token : undefined;
    warpCoreConfig.tokens.push({
      chainName,
      standard: TOKEN_TYPE_TO_STANDARD[config.type],
      ...metadata,
      decimals,
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
