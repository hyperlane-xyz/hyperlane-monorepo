import { confirm } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  EvmERC20WarpModule,
  EvmIsmModule,
  HypERC20Deployer,
  HypERC721Deployer,
  HyperlaneAddresses,
  HyperlaneContractsMap,
  HyperlaneProxyFactoryDeployer,
  MultiProvider,
  ProxyFactoryFactoriesAddresses,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  getTokenConnectionId,
  isTokenMetadata,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import {
  log,
  logBlue,
  logGray,
  logGreen,
  logRed,
  logTable,
} from '../logger.js';
import {
  indentYamlOrJson,
  isFile,
  runFileSelectionStep,
} from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runPreflightChecksForChains,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfig;
}

interface ApplyParams extends DeployParams {
  warpCoreConfig: WarpCoreConfig;
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
    warpDeployConfig: warpRouteConfig,
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

async function runDeployPlanStep({ context, warpDeployConfig }: DeployParams) {
  const { skipConfirmation } = context;

  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Using token standard ${warpDeployConfig.isNft ? 'ERC721' : 'ERC20'}`);
  logTable(warpDeployConfig);

  if (skipConfirmation || context.isDryRun) return;

  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy(params: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');

  const {
    warpDeployConfig,
    context: { registry, multiProvider, isDryRun, dryRunChain },
  } = params;

  const deployer = warpDeployConfig.isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider);

  const config: WarpRouteDeployConfig =
    isDryRun && dryRunChain
      ? { [dryRunChain]: warpDeployConfig[dryRunChain] }
      : warpDeployConfig;

  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism address as a string
  const modifiedConfig = await deployAndResolveWarpIsm(
    config,
    multiProvider,
    registry,
    ismFactoryDeployer,
  );

  const deployedContracts = await deployer.deploy(modifiedConfig);

  const warpCoreConfig = await getWarpCoreConfig(params, deployedContracts);
  logGreen('✅ Warp contract deployments complete');

  if (!isDryRun) {
    log('Writing deployment artifacts...');
    await registry.addWarpRoute(warpCoreConfig);
  }
  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
}

async function deployAndResolveWarpIsm(
  warpConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  registry: IRegistry,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
): Promise<WarpRouteDeployConfig> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      // Skip deployment if Ism is empty, or a string
      if (
        !config.interchainSecurityModule ||
        typeof config.interchainSecurityModule === 'string'
      ) {
        logGray(
          `Config Ism is ${
            !config.interchainSecurityModule
              ? 'empty'
              : config.interchainSecurityModule
          }, skipping deployment`,
        );
        return config;
      }

      logBlue('Loading Registry factory addresses');
      let chainAddresses = await registry.getChainAddresses(chain); // Can includes other addresses

      if (!chainAddresses) {
        logGray('Registry factory addresses not found, deploying');
        chainAddresses = serializeContracts(
          await ismFactoryDeployer.deployContracts(chain),
        ) as Record<string, string>;
      }

      logGray(
        `Creating ${config.interchainSecurityModule.type} Ism for ${config.type} token on ${chain} chain`,
      );

      const deployedIsm = await createWarpIsm(
        chain,
        warpConfig,
        multiProvider,
        {
          domainRoutingIsmFactory: chainAddresses.domainRoutingIsmFactory,
          staticAggregationHookFactory:
            chainAddresses.staticAggregationHookFactory,
          staticAggregationIsmFactory:
            chainAddresses.staticAggregationIsmFactory,
          staticMerkleRootMultisigIsmFactory:
            chainAddresses.staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory:
            chainAddresses.staticMessageIdMultisigIsmFactory,
        },
      );

      logGreen(
        `Finished creating ${config.interchainSecurityModule.type} Ism for ${config.type} token on ${chain} chain`,
      );
      return { ...warpConfig[chain], interchainSecurityModule: deployedIsm };
    }),
  );
}

/**
 * Deploys the Warp ISM for a given config
 *
 * @returns The deployed ism address
 */
async function createWarpIsm(
  chain: string,
  warpConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  factoryAddresses: HyperlaneAddresses<any>,
): Promise<string> {
  const {
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
  } = factoryAddresses;
  const evmIsmModule = await EvmIsmModule.create({
    chain,
    multiProvider,
    mailbox: warpConfig[chain].mailbox,
    proxyFactoryFactories: {
      domainRoutingIsmFactory,
      staticAggregationHookFactory,
      staticAggregationIsmFactory,
      staticMerkleRootMultisigIsmFactory,
      staticMessageIdMultisigIsmFactory,
    },
    config: warpConfig[chain].interchainSecurityModule!,
  });
  const { deployedIsm } = evmIsmModule.serialize();
  return deployedIsm;
}

async function getWarpCoreConfig(
  { warpDeployConfig, context }: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): Promise<WarpCoreConfig> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    context.multiProvider,
    warpDeployConfig,
  );
  assert(
    tokenMetadata && isTokenMetadata(tokenMetadata),
    'Missing required token metadata',
  );
  const { decimals, symbol, name } = tokenMetadata;
  assert(decimals, 'Missing decimals on token metadata');

  // First pass, create token configs
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = warpDeployConfig[chainName];
    const collateralAddressOrDenom =
      config.type === TokenType.collateral ? config.token : undefined;
    warpCoreConfig.tokens.push({
      chainName,
      standard: TOKEN_TYPE_TO_STANDARD[config.type],
      decimals,
      symbol,
      name,
      addressOrDenom:
        contract[warpDeployConfig[chainName].type as keyof TokenFactories]
          .address,
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

export async function runWarpRouteApply(params: ApplyParams) {
  const {
    warpDeployConfig,
    warpCoreConfig,
    context: { registry, multiProvider },
  } = params;

  // Addresses used to get static Ism factories
  const addresses = await registry.getAddresses();

  // Convert warpCoreConfig.tokens[] into a mapping of { [chainName]: Config }
  // This allows O(1) reads within the loop
  const warpCoreByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );

  // Attempt to update Warp Routes
  // Can update existing or deploy new contracts
  logGray(`Comparing target and onchain Warp configs`);
  await promiseObjAll(
    objMap(warpDeployConfig, async (chain, config) => {
      try {
        // Update Warp
        config.ismFactoryAddresses = addresses[
          chain
        ] as ProxyFactoryFactoriesAddresses;
        const evmERC20WarpModule = new EvmERC20WarpModule(multiProvider, {
          config,
          chain,
          addresses: {
            deployedTokenRoute: warpCoreByChain[chain].addressOrDenom!,
          },
        });
        const transactions = await evmERC20WarpModule.update(config);

        // Send Txs
        if (transactions.length) {
          for (const transaction of transactions) {
            await multiProvider.sendTransaction(chain, transaction);
          }

          logGreen(`Warp config updated on ${chain}.`);
        } else {
          logGreen(
            `Warp config on ${chain} is the same as target. No updates needed.`,
          );
        }
      } catch (e) {
        logRed(`Warp config on ${chain} failed to update.`, e);
      }
    }),
  );
}
