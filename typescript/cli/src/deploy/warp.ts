import { confirm } from '@inquirer/prompts';
import { ContractReceipt } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { IRegistry } from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  ContractVerifier,
  EvmERC20WarpModule,
  EvmERC20WarpRouteReader,
  EvmIsmModule,
  ExplorerLicenseType,
  HypERC20Deployer,
  HypERC20Factories,
  HypERC721Deployer,
  HypERC721Factories,
  HyperlaneAddresses,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneProxyFactoryDeployer,
  IsmType,
  MultiProvider,
  MultisigIsmConfig,
  OpStackIsmConfig,
  PausableIsmConfig,
  ProxyFactoryFactoriesAddresses,
  RemoteRouters,
  RoutingIsmConfig,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TrustedRelayerIsmConfig,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  attachContractsMap,
  connectContractsMap,
  getTokenConnectionId,
  hypERC20factories,
  isCollateralConfig,
  isTokenMetadata,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { getOrRequestApiKeys } from '../context/context.js';
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
  const { signer, skipConfirmation, chainMetadata } = context;

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

  const chains = Object.keys(warpRouteConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await getOrRequestApiKeys(chains, chainMetadata);

  const deploymentParams = {
    context,
    warpDeployConfig: warpRouteConfig,
  };

  await runDeployPlanStep(deploymentParams);

  await runPreflightChecksForChains({
    context,
    chains,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, chains);

  const deployedContracts = await executeDeploy(deploymentParams, apiKeys);

  const warpCoreConfig = await getWarpCoreConfig(
    deploymentParams,
    deployedContracts,
  );

  await writeDeploymentArtifacts(warpCoreConfig, context);

  await completeDeploy(context, 'warp', initialBalances, userAddress, chains);
}

async function runDeployPlanStep({ context, warpDeployConfig }: DeployParams) {
  const { skipConfirmation } = context;

  displayWarpDeployPlan(warpDeployConfig);

  if (skipConfirmation || context.isDryRun) return;

  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy(
  params: DeployParams,
  apiKeys: ChainMap<string>,
): Promise<HyperlaneContractsMap<HypERC20Factories | HypERC721Factories>> {
  logBlue('🚀 All systems ready, captain! Beginning deployment...');

  const {
    warpDeployConfig,
    context: { registry, multiProvider, isDryRun, dryRunChain },
  } = params;

  const deployer = warpDeployConfig.isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider); // TODO: replace with EvmERC20WarpModule

  const config: WarpRouteDeployConfig =
    isDryRun && dryRunChain
      ? { [dryRunChain]: warpDeployConfig[dryRunChain] }
      : warpDeployConfig;

  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(
    multiProvider,
    contractVerifier,
  );

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism address as a string
  const modifiedConfig = await deployAndResolveWarpIsm(
    config,
    multiProvider,
    registry,
    ismFactoryDeployer,
    contractVerifier,
  );

  const deployedContracts = await deployer.deploy(modifiedConfig);

  logGreen('✅ Warp contract deployments complete');
  return deployedContracts;
}

async function writeDeploymentArtifacts(
  warpCoreConfig: WarpCoreConfig,
  context: WriteCommandContext,
) {
  if (!context.isDryRun) {
    log('Writing deployment artifacts...');
    await context.registry.addWarpRoute(warpCoreConfig);
  }
  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
}

async function deployAndResolveWarpIsm(
  warpConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  registry: IRegistry,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
  contractVerifier?: ContractVerifier,
): Promise<WarpRouteDeployConfig> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      if (
        !config.interchainSecurityModule ||
        typeof config.interchainSecurityModule === 'string'
      ) {
        logGray(
          `Config Ism is ${
            !config.interchainSecurityModule
              ? 'empty'
              : config.interchainSecurityModule
          }, skipping deployment.`,
        );
        return config;
      }

      logBlue(`Loading registry factory addresses for ${chain}...`);
      let chainAddresses = await registry.getChainAddresses(chain);

      if (!chainAddresses) {
        logGray(
          `Registry factory addresses not found for ${chain}. Deploying...`,
        );
        chainAddresses = serializeContracts(
          await ismFactoryDeployer.deployContracts(chain),
        ) as Record<string, string>;
      }

      logGray(
        `Creating ${config.interchainSecurityModule.type} ISM for ${config.type} token on ${chain} chain...`,
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
        contractVerifier,
      );

      logGreen(
        `Finished creating ${config.interchainSecurityModule.type} ISM for ${config.type} token on ${chain} chain.`,
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
  contractVerifier?: ContractVerifier,
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
    contractVerifier,
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

  generateTokenConfigs(
    warpCoreConfig,
    warpDeployConfig,
    contracts,
    symbol,
    name,
    decimals,
  );

  fullyConnectTokens(warpCoreConfig);

  return warpCoreConfig;
}

/**
 * Creates token configs.
 */
function generateTokenConfigs(
  warpCoreConfig: WarpCoreConfig,
  warpDeployConfig: WarpRouteDeployConfig,
  contracts: HyperlaneContractsMap<TokenFactories>,
  symbol: string,
  name: string,
  decimals: number,
): void {
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = warpDeployConfig[chainName];
    const collateralAddressOrDenom = isCollateralConfig(config)
      ? config.token // gets set in the above deriveTokenMetadata()
      : undefined;

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
}

/**
 * Adds connections between tokens.
 *
 * Assumes full interconnectivity between all tokens for now b.c. that's
 * what the deployers do by default.
 */
function fullyConnectTokens(warpCoreConfig: WarpCoreConfig): void {
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
}

export async function runWarpRouteApply(params: ApplyParams): Promise<void> {
  const { warpDeployConfig, warpCoreConfig, context } = params;
  const { registry, multiProvider, chainMetadata, skipConfirmation } = context;
  WarpRouteDeployConfigSchema.parse(warpDeployConfig);
  WarpCoreConfigSchema.parse(warpCoreConfig);
  const addresses = await registry.getAddresses();

  const warpCoreConfigByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [
      token.chainName,
      token,
    ]) /* Necessary for O(1) reads below */,
  );

  const chains = Object.keys(warpDeployConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await getOrRequestApiKeys(chains, chainMetadata);

  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  const warpDeployChains = Object.keys(warpDeployConfig);
  const warpCoreChains = Object.keys(warpCoreConfigByChain);
  if (warpDeployChains.length === warpCoreChains.length) {
    logGray('Updating deployed Warp Routes');
    await promiseObjAll(
      objMap(warpDeployConfig, async (chain, config) => {
        try {
          config.ismFactoryAddresses = addresses[
            chain
          ] as ProxyFactoryFactoriesAddresses;
          const evmERC20WarpModule = new EvmERC20WarpModule(
            multiProvider,
            {
              config,
              chain,
              addresses: {
                deployedTokenRoute:
                  warpCoreConfigByChain[chain].addressOrDenom!,
              },
            },
            contractVerifier,
          );
          const transactions = await evmERC20WarpModule.update(config);

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
  } else if (warpDeployChains.length > warpCoreChains.length) {
    logGray('Extending deployed Warp configs');

    // Split between the existing and additional config
    const existingConfigs: WarpRouteDeployConfig = objFilter(
      warpDeployConfig,
      (chain, _config): _config is any => warpCoreChains.includes(chain),
    );

    let extendedConfigs: WarpRouteDeployConfig = objFilter(
      warpDeployConfig,
      (chain, _config): _config is any => !warpCoreChains.includes(chain),
    );

    const existingTokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
      multiProvider,
      existingConfigs,
    );
    extendedConfigs = objMap(extendedConfigs, (_chain, extendedConfig) => {
      return {
        ...extendedConfig,
        ...existingTokenMetadata,
      };
    });

    const newExtensionContracts = await executeDeploy(
      {
        // TODO: use EvmERC20WarpModule when it's ready
        context,
        warpDeployConfig: extendedConfigs,
      },
      apiKeys,
    );

    const existingContractAddresses = objMap(
      existingConfigs,
      (chain, config) => ({
        [config.type]: warpCoreConfigByChain[chain].addressOrDenom!,
      }),
    );
    const mergedRouters = {
      ...connectContractsMap(
        attachContractsMap(existingContractAddresses, hypERC20factories),
        multiProvider,
      ),
      ...newExtensionContracts,
    } as HyperlaneContractsMap<HypERC20Factories>;

    await enrollRemoteRouters(mergedRouters, multiProvider);

    const updatedWarpCoreConfig = await getWarpCoreConfig(
      params,
      mergedRouters,
    );
    WarpCoreConfigSchema.parse(updatedWarpCoreConfig);
    await writeDeploymentArtifacts(updatedWarpCoreConfig, context);
  } else {
    throw new Error('Unenrolling warp routes is currently not supported');
  }
}

/**
 * Enroll all deployed routers with each other.
 *
 * @param deployedContractsMap - A map of deployed Hyperlane contracts by chain.
 * @param multiProvider - A MultiProvider instance to interact with multiple chains.
 */
async function enrollRemoteRouters(
  deployedContractsMap: HyperlaneContractsMap<HypERC20Factories>,
  multiProvider: MultiProvider,
): Promise<void> {
  logBlue(`Enrolling deployed routers with each other (if not already)...`);
  const deployedRouters: ChainMap<Address> = objMap(
    deployedContractsMap,
    (_, contracts) => getRouter(contracts).address,
  );
  const allChains = Object.keys(deployedRouters);

  await promiseObjAll(
    objMap(deployedContractsMap, async (chain, contracts) => {
      const router = getRouter(contracts); // Assume deployedContract always has 1 value

      // Mutate the config.remoteRouters by setting it to all other routers to update
      const warpRouteReader = new EvmERC20WarpRouteReader(multiProvider, chain);
      const mutatedWarpRouteConfig =
        await warpRouteReader.deriveWarpRouteConfig(router.address);
      const evmERC20WarpModule = new EvmERC20WarpModule(multiProvider, {
        config: mutatedWarpRouteConfig,
        chain,
        addresses: { deployedTokenRoute: router.address },
      });

      const otherChains = multiProvider
        .getRemoteChains(chain)
        .filter((c) => allChains.includes(c));

      mutatedWarpRouteConfig.remoteRouters = otherChains.reduce<RemoteRouters>(
        (remoteRouters, chain) => {
          remoteRouters[multiProvider.getDomainId(chain)] =
            deployedRouters[chain];
          return remoteRouters;
        },
        {},
      );
      const mutatedConfigTxs: AnnotatedEV5Transaction[] =
        await evmERC20WarpModule.update(mutatedWarpRouteConfig);
      for (const transaction of mutatedConfigTxs) {
        const receipt: ContractReceipt = await multiProvider.sendTransaction(
          chain,
          transaction,
        );
        logGreen(
          `Successfully enrolled routers on ${chain}: ${receipt.transactionHash}`,
        );
      }
    }),
  );
}

function getRouter(contracts: HyperlaneContracts<HypERC20Factories>) {
  for (const key of objKeys(hypERC20factories)) {
    if (contracts[key]) return contracts[key];
  }
  throw new Error('No matching contract found.');
}

function displayWarpDeployPlan(deployConfig: WarpRouteDeployConfig) {
  logBlue('\nWarp Route Deployment Plan');
  logGray('==========================');
  log(`📋 Token Standard: ${deployConfig.isNft ? 'ERC721' : 'ERC20'}`);

  const { transformedDeployConfig, transformedIsmConfigs } =
    transformDeployConfigForDisplay(deployConfig);

  log('📋 Warp Route Config:');
  logTable(transformedDeployConfig);
  objMap(transformedIsmConfigs, (chain, ismConfigs) => {
    log(`📋 ${chain} ISM Config(s):`);
    ismConfigs.forEach((ismConfig) => {
      logTable(ismConfig);
    });
  });
}

/* only used for transformIsmForDisplay type-sense */
type IsmConfig =
  | RoutingIsmConfig // type, owner, ownerOverrides, domain
  | AggregationIsmConfig // type, modules, threshold
  | MultisigIsmConfig // type, validators, threshold
  | OpStackIsmConfig // type, origin, nativeBridge
  | PausableIsmConfig // type, owner, paused, ownerOverrides
  | TrustedRelayerIsmConfig; // type, relayer

function transformDeployConfigForDisplay(deployConfig: WarpRouteDeployConfig) {
  const transformedIsmConfigs: Record<ChainName, any[]> = {};
  const transformedDeployConfig = objMap(deployConfig, (chain, config) => {
    if (config.interchainSecurityModule)
      transformedIsmConfigs[chain] = transformIsmConfigForDisplay(
        config.interchainSecurityModule as IsmConfig,
      );

    return {
      'NFT?': config.isNft ?? false,
      Type: config.type,
      Owner: config.owner,
      Mailbox: config.mailbox,
      'ISM Config(s)': config.interchainSecurityModule
        ? 'See table(s) below.'
        : 'No ISM config(s) specified.',
    };
  });

  return {
    transformedDeployConfig,
    transformedIsmConfigs,
  };
}

function transformIsmConfigForDisplay(ismConfig: IsmConfig): any[] {
  const ismConfigs: any[] = [];
  switch (ismConfig.type) {
    case IsmType.AGGREGATION:
      ismConfigs.push({
        Type: ismConfig.type,
        Threshold: ismConfig.threshold,
        Modules: 'See table(s) below.',
      });
      ismConfig.modules.forEach((module) => {
        ismConfigs.push(...transformIsmConfigForDisplay(module as IsmConfig));
      });
      return ismConfigs;
    case IsmType.ROUTING:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          'Owner Overrides': ismConfig.ownerOverrides ?? 'Undefined',
          Domains: 'See warp config for domain specification.',
        },
      ];
    case IsmType.FALLBACK_ROUTING:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          'Owner Overrides': ismConfig.ownerOverrides ?? 'Undefined',
          Domains: 'See warp config for domain specification.',
        },
      ];
    case IsmType.MERKLE_ROOT_MULTISIG:
      return [
        {
          Type: ismConfig.type,
          Validators: ismConfig.validators,
          Threshold: ismConfig.threshold,
        },
      ];
    case IsmType.MESSAGE_ID_MULTISIG:
      return [
        {
          Type: ismConfig.type,
          Validators: ismConfig.validators,
          Threshold: ismConfig.threshold,
        },
      ];
    case IsmType.OP_STACK:
      return [
        {
          Type: ismConfig.type,
          Origin: ismConfig.origin,
          'Native Bridge': ismConfig.nativeBridge,
        },
      ];
    case IsmType.PAUSABLE:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          'Paused ?': ismConfig.paused,
          'Owner Overrides': ismConfig.ownerOverrides ?? 'Undefined',
        },
      ];
    case IsmType.TRUSTED_RELAYER:
      return [
        {
          Type: ismConfig.type,
          Relayer: ismConfig.relayer,
        },
      ];
    default:
      return [ismConfig];
  }
}
