import { confirm } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { IRegistry } from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  ContractVerifier,
  CoreAddresses,
  EvmERC20WarpModule,
  EvmERC20WarpRouteReader,
  EvmHookModule,
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
  SubmissionStrategy,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TrustedRelayerIsmConfig,
  TxSubmitterBuilder,
  TxSubmitterType,
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
import { TokenRouterConfig } from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  isNullish,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { ProxyFactoryFactories } from '../../../sdk/dist/deploy/contracts.js';
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
import { getSubmitterBuilder } from '../submit/submit.js';
import {
  indentYamlOrJson,
  isFile,
  readYamlOrJson,
  runFileSelectionStep,
  writeYamlOrJson,
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

interface WarpApplyParams extends DeployParams {
  warpCoreConfig: WarpCoreConfig;
  strategyUrl?: string;
  receiptsDir: string;
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
  const modifiedConfig: WarpRouteDeployConfig = await promiseObjAll(
    objMap(
      config,
      async (chain: string, tokenRouterConfig: TokenRouterConfig) => {
        const proxyFactoryFactoriesAddresses = await getOrDeployIsmFactories(
          registry,
          chain,
          ismFactoryDeployer,
        );
        // If a new ISM is configured in the WarpRouteConfig, deploy that ISM
        // Then return a modified config with the ism address as a string
        const configWithDeployedIsm = await deployAndResolveWarpIsm(
          chain,
          tokenRouterConfig,
          multiProvider,
          proxyFactoryFactoriesAddresses,
          contractVerifier,
        );

        // If a new hook is configured in the WarpRouteConfig, deploy that hook
        // Then return the modified config with the hook address as a string
        const configWithDeployedHook = await deployAndResolveWarpHook(
          chain,
          tokenRouterConfig,
          multiProvider,
          proxyFactoryFactoriesAddresses,
          contractVerifier,
        );
        return { ...configWithDeployedIsm, ...configWithDeployedHook };
      },
    ),
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
  chain: string,
  tokenRouterConfig: TokenRouterConfig,
  multiProvider: MultiProvider,
  proxyFactoryFactoriesAddresses: HyperlaneAddresses<ProxyFactoryFactories>,
  contractVerifier?: ContractVerifier,
): Promise<TokenRouterConfig> {
  if (
    !tokenRouterConfig.interchainSecurityModule ||
    typeof tokenRouterConfig.interchainSecurityModule === 'string'
  ) {
    logGray(
      `Config Ism is ${
        !tokenRouterConfig.interchainSecurityModule
          ? 'empty'
          : tokenRouterConfig.interchainSecurityModule
      }, skipping deployment.`,
    );
    return tokenRouterConfig;
  }

  logGray(
    `Creating ${tokenRouterConfig.interchainSecurityModule.type} ISM for ${tokenRouterConfig.type} token on ${chain} chain...`,
  );
  const deployedIsm = await createWarpIsm(
    chain,
    tokenRouterConfig,
    multiProvider,
    proxyFactoryFactoriesAddresses,
    contractVerifier,
  );

  logGreen(
    `Finished creating ${tokenRouterConfig.interchainSecurityModule.type} ISM for ${tokenRouterConfig.type} token on ${chain} chain.`,
  );
  tokenRouterConfig.interchainSecurityModule = deployedIsm;
  return tokenRouterConfig;
}

/**
 * Deploys the Warp ISM for a given config
 *
 * @returns The deployed ism address
 */
async function createWarpIsm(
  chain: string,
  tokenRouterConfig: TokenRouterConfig,
  multiProvider: MultiProvider,
  factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>,
  contractVerifier?: ContractVerifier,
): Promise<string> {
  const evmIsmModule = await EvmIsmModule.create({
    chain,
    multiProvider,
    mailbox: tokenRouterConfig.mailbox,
    proxyFactoryFactories: factoryAddresses,
    config: tokenRouterConfig.interchainSecurityModule!,
    contractVerifier,
  });
  const { deployedIsm } = evmIsmModule.serialize();
  return deployedIsm;
}

/**
 * Deploys the custom hook for chains with a custom configuration
 *
 * @returns The updated config with the deployed hook address
 */
async function deployAndResolveWarpHook(
  chain: string,
  tokenRouterConfig: TokenRouterConfig,
  multiProvider: MultiProvider,
  proxyFactoryFactoriesAddresses: HyperlaneAddresses<ProxyFactoryFactories>,
  contractVerifier?: ContractVerifier,
): Promise<TokenRouterConfig> {
  if (!tokenRouterConfig.hook || typeof tokenRouterConfig.hook === 'string') {
    logGray(
      `Config Hook is ${
        !tokenRouterConfig.hook ? 'empty' : tokenRouterConfig.hook
      }, skipping deployment.`,
    );
    return tokenRouterConfig;
  }

  logGray(
    `Creating ${tokenRouterConfig.hook.type} Hook for ${tokenRouterConfig.type} token on ${chain} chain...`,
  );

  const deployedHook = await createWarpHook(
    chain,
    tokenRouterConfig,
    multiProvider,
    proxyFactoryFactoriesAddresses,
    contractVerifier,
  );

  logGreen(
    `Finished creating ${tokenRouterConfig.hook.type} ISM for ${tokenRouterConfig.type} token on ${chain} chain.`,
  );

  tokenRouterConfig.hook = deployedHook;
  return tokenRouterConfig;
}

/**
 * Deploys the Warp Hook for a given config
 *
 * @returns The deployed hook address
 */
async function createWarpHook(
  chain: string,
  tokenRouterConfig: TokenRouterConfig,
  multiProvider: MultiProvider,
  proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>,
  contractVerifier?: ContractVerifier,
): Promise<Address> {
  const proxyAdmin = (
    await multiProvider.handleDeploy(chain, new ProxyAdmin__factory(), [])
  ).address;

  const coreAddresses: Omit<CoreAddresses, 'validatorAnnounce'> = {
    mailbox: tokenRouterConfig.mailbox,
    proxyAdmin,
  };

  const evmHookModule = await EvmHookModule.create({
    chain,
    multiProvider,
    proxyFactoryFactories,
    coreAddresses,
    config: tokenRouterConfig.hook!,
    contractVerifier,
  });

  const { deployedHook } = evmHookModule.serialize();
  return deployedHook;
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

async function getOrDeployIsmFactories(
  registry: IRegistry,
  chain: string,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
): Promise<HyperlaneAddresses<ProxyFactoryFactories>> {
  logBlue(`Loading registry factory addresses for ${chain}...`);
  let chainAddresses = await registry.getChainAddresses(chain);

  if (!chainAddresses) {
    logGray(`Registry factory addresses not found for ${chain}. Deploying...`);
    chainAddresses = serializeContracts(
      await ismFactoryDeployer.deployContracts(chain),
    );
  }
  // Should never be empty because Factories will be deployed above
  assert(chainAddresses, 'Ism Factories undefined');

  const proxyFactoryFactoriesAddresses = {
    staticAggregationHookFactory: chainAddresses.staticAggregationHookFactory,
    staticAggregationIsmFactory: chainAddresses.staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory:
      chainAddresses.staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory:
      chainAddresses.staticMessageIdMultisigIsmFactory,
    domainRoutingIsmFactory: chainAddresses.domainRoutingIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory:
      chainAddresses.staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory:
      chainAddresses.staticMessageIdWeightedMultisigIsmFactory,
  };
  await validateIndividualFactoryAddresses(
    chain,
    proxyFactoryFactoriesAddresses,
  );

  return proxyFactoryFactoriesAddresses;
}

/**
 * Validates that all individual ISM factory addresses are defined for the given chain.
 * Throws an error if any factory address is null or empty.
 *
 * @param chain - The chain to validate the factory addresses for.
 * @param proxyFactoryFactoriesAddresses - ISM factory addresses to validate.
 * @throws Error if any factory address is null or empty.
 */
async function validateIndividualFactoryAddresses(
  chain: Address,
  proxyFactoryFactoriesAddresses: HyperlaneAddresses<ProxyFactoryFactories>,
) {
  const nullAddresses = objFilter(
    proxyFactoryFactoriesAddresses,
    (_, address): address is string => isNullish(address) || address === '',
  );
  const nullFactoryNames = Object.keys(nullAddresses).join(', ');

  if (nullFactoryNames)
    throw new Error(
      `Undefined ISM factory address(es) for ${nullFactoryNames} on ${chain}. Deployment terminating. \nConsider deploying with 'hyperlane core deploy'`,
    );
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

export async function runWarpRouteApply(
  params: WarpApplyParams,
): Promise<void> {
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

          if (transactions.length == 0)
            return logGreen(
              `Warp config on ${chain} is the same as target. No updates needed.`,
            );
          await submitWarpApplyTransactions(chain, params, transactions);
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

    extendedConfigs = await deriveMetadataFromExisting(
      multiProvider,
      existingConfigs,
      extendedConfigs,
    );

    const newDeployedContracts = await executeDeploy(
      {
        // TODO: use EvmERC20WarpModule when it's ready
        context,
        warpDeployConfig: extendedConfigs,
      },
      apiKeys,
    );

    const mergedRouters = mergeAllRouters(
      multiProvider,
      existingConfigs,
      newDeployedContracts,
      warpCoreConfigByChain,
    );

    await enrollRemoteRouters(params, mergedRouters);

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
 * Retrieves a chain submission strategy from the provided filepath.
 * @param submissionStrategyFilepath a filepath to the submission strategy file
 * @returns a formatted submission strategy
 */
export function readChainSubmissionStrategy(
  submissionStrategyFilepath: string,
): ChainSubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return ChainSubmissionStrategySchema.parse(submissionStrategyFileContent);
}

/**
 * Derives token metadata from existing config and merges it with extended config.
 * @returns The merged Warp route deployment config with token metadata.
 */
async function deriveMetadataFromExisting(
  multiProvider: MultiProvider,
  existingConfigs: WarpRouteDeployConfig,
  extendedConfigs: WarpRouteDeployConfig,
): Promise<WarpRouteDeployConfig> {
  const existingTokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    multiProvider,
    existingConfigs,
  );
  return objMap(extendedConfigs, (_chain, extendedConfig) => {
    return {
      ...existingTokenMetadata,
      ...extendedConfig,
    };
  });
}

/**
 * Merges existing router configs with newly deployed router contracts.
 */
function mergeAllRouters(
  multiProvider: MultiProvider,
  existingConfigs: WarpRouteDeployConfig,
  deployedContractsMap: HyperlaneContractsMap<
    HypERC20Factories | HypERC721Factories
  >,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
) {
  const existingContractAddresses = objMap(
    existingConfigs,
    (chain, config) => ({
      [config.type]: warpCoreConfigByChain[chain].addressOrDenom!,
    }),
  );
  return {
    ...connectContractsMap(
      attachContractsMap(existingContractAddresses, hypERC20factories),
      multiProvider,
    ),
    ...deployedContractsMap,
  } as HyperlaneContractsMap<HypERC20Factories>;
}

/**
 * Enroll all deployed routers with each other.
 *
 * @param deployedContractsMap - A map of deployed Hyperlane contracts by chain.
 * @param multiProvider - A MultiProvider instance to interact with multiple chains.
 */
async function enrollRemoteRouters(
  params: WarpApplyParams,
  deployedContractsMap: HyperlaneContractsMap<HypERC20Factories>,
): Promise<void> {
  logBlue(`Enrolling deployed routers with each other...`);
  const { multiProvider } = params.context;
  const deployedRouters: ChainMap<Address> = objMap(
    deployedContractsMap,
    (_, contracts) => getRouter(contracts).address,
  );
  const allChains = Object.keys(deployedRouters);
  await promiseObjAll(
    objMap(deployedContractsMap, async (chain, contracts) => {
      await retryAsync(async () => {
        const router = getRouter(contracts); // Assume deployedContract always has 1 value

        // Mutate the config.remoteRouters by setting it to all other routers to update
        const warpRouteReader = new EvmERC20WarpRouteReader(
          multiProvider,
          chain,
        );
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

        mutatedWarpRouteConfig.remoteRouters =
          otherChains.reduce<RemoteRouters>((remoteRouters, chain) => {
            remoteRouters[multiProvider.getDomainId(chain)] =
              deployedRouters[chain];
            return remoteRouters;
          }, {});
        const mutatedConfigTxs: AnnotatedEV5Transaction[] =
          await evmERC20WarpModule.update(mutatedWarpRouteConfig);

        if (mutatedConfigTxs.length == 0)
          return logGreen(
            `Warp config on ${chain} is the same as target. No updates needed.`,
          );
        await submitWarpApplyTransactions(chain, params, mutatedConfigTxs);
      });
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

/**
 * Submits a set of transactions to the specified chain and outputs transaction receipts
 */
async function submitWarpApplyTransactions(
  chain: string,
  params: WarpApplyParams,
  transactions: AnnotatedEV5Transaction[],
) {
  const submitter: TxSubmitterBuilder<ProtocolType> =
    await getWarpApplySubmitter({
      chain,
      context: params.context,
      strategyUrl: params.strategyUrl,
    });

  const transactionReceipts = await submitter.submit(...transactions);
  if (transactionReceipts) {
    const receiptPath = `${params.receiptsDir}/${chain}-${
      submitter.txSubmitterType
    }-${Date.now()}-receipts.json`;
    writeYamlOrJson(receiptPath, transactionReceipts);
    logGreen(`Transactions receipts successfully written to ${receiptPath}`);
  }

  return logGreen(
    `✅ Warp route update success with ${submitter.txSubmitterType} on ${chain}:\n\n`,
    indentYamlOrJson(yamlStringify(transactionReceipts, null, 2), 0),
  );
}

/**
 * Helper function to get warp apply specific submitter.
 *
 * @returns the warp apply submitter
 */
async function getWarpApplySubmitter({
  chain,
  context,
  strategyUrl,
}: {
  chain: ChainName;
  context: WriteCommandContext;
  strategyUrl?: string;
}): Promise<TxSubmitterBuilder<ProtocolType>> {
  const { chainMetadata, multiProvider } = context;

  const submissionStrategy: SubmissionStrategy = strategyUrl
    ? readChainSubmissionStrategy(strategyUrl)[chain]
    : {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      };

  const protocol = chainMetadata[chain].protocol;
  return getSubmitterBuilder<typeof protocol>({
    submissionStrategy,
    multiProvider,
  });
}
