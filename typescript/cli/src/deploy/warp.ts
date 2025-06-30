import { confirm } from '@inquirer/prompts';
import { groupBy } from 'lodash-es';
import { stringify as yamlStringify } from 'yaml';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  AddWarpRouteConfigOptions,
  BaseRegistry,
  ChainAddresses,
} from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  AnnotatedEV5Transaction,
  CCIPContractCache,
  ChainMap,
  ChainName,
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  ContractVerifier,
  CosmosNativeDeployer,
  CosmosNativeIsmModule,
  CosmosNativeWarpModule,
  EvmERC20WarpModule,
  EvmHookModule,
  EvmIsmModule,
  ExplorerLicenseType,
  GroupedTransactions,
  HookConfig,
  HypERC20Deployer,
  HypERC20Factories,
  HypERC721Deployer,
  HypTokenRouterConfig,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneProxyFactoryDeployer,
  IsmConfig,
  IsmType,
  MultiProvider,
  MultisigIsmConfig,
  OpStackIsmConfig,
  PausableIsmConfig,
  RoutingIsmConfig,
  SubmissionStrategy,
  SubmissionStrategySchema,
  TokenMetadataMap,
  TrustedRelayerIsmConfig,
  TxSubmitterBuilder,
  TxSubmitterType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
  expandWarpDeployConfig,
  extractIsmAndHookFactoryAddresses,
  getRouterAddressesFromWarpCoreConfig,
  getSubmitterBuilder,
  getTokenConnectionId,
  hypERC20factories,
  isCollateralTokenConfig,
  isXERC20TokenConfig,
  splitWarpCoreAndExtendedConfigs,
  tokenTypeToStandard,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  isObjEmpty,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { WriteCommandContext } from '../context/types.js';
import {
  log,
  logBlue,
  logGray,
  logGreen,
  logTable,
  warnYellow,
} from '../logger.js';
import { WarpSendLogs } from '../send/transfer.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';
import { canSelfRelay, runSelfRelay } from '../utils/relay.js';

import {
  completeDeploy,
  prepareDeploy,
  runPreflightChecksForChains,
  validateWarpIsmCompatibility,
  warpRouteIdFromFileName,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}

interface WarpApplyParams extends DeployParams {
  warpCoreConfig: WarpCoreConfig;
  strategyUrl?: string;
  receiptsDir: string;
  selfRelay?: boolean;
  warpRouteId?: string;
}

export async function runWarpRouteDeploy({
  context,
  warpDeployConfig,
  warpRouteId,
  warpDeployConfigFileName,
}: {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpRouteId?: string;
  warpDeployConfigFileName?: string;
}) {
  const { skipConfirmation, chainMetadata, registry } = context;

  // Validate ISM compatibility for all chains
  validateWarpIsmCompatibility(warpDeployConfig, context);

  const chains = Object.keys(warpDeployConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(chains, chainMetadata, registry);

  const deploymentParams = {
    context,
    warpDeployConfig,
  };

  await runDeployPlanStep(deploymentParams);

  // Some of the below functions throw if passed non-EVM or Cosmos Native chains
  const deploymentChains = chains.filter(
    (chain) =>
      chainMetadata[chain].protocol === ProtocolType.Ethereum ||
      chainMetadata[chain].protocol === ProtocolType.CosmosNative,
  );

  await runPreflightChecksForChains({
    context,
    chains: deploymentChains,
    minGas: MINIMUM_WARP_DEPLOY_GAS,
  });

  const initialBalances = await prepareDeploy(context, null, deploymentChains);

  const { deployedContracts } = await executeDeploy(deploymentParams, apiKeys);

  await enrollCrossChainRouters(
    { context, warpDeployConfig },
    deployedContracts,
  );

  const { warpCoreConfig, addWarpRouteOptions } = await getWarpCoreConfig(
    deploymentParams,
    deployedContracts,
  );

  // Use warpRouteId if provided, otherwise if the user is deploying
  // using a config file use the name of the file to generate the id
  // or just fallback to use the warpCoreConfig symbol
  let warpRouteIdOptions: AddWarpRouteConfigOptions;
  if (warpRouteId) {
    warpRouteIdOptions = { warpRouteId };
  } else if (warpDeployConfigFileName && 'symbol' in addWarpRouteOptions) {
    // validate that the id is correct
    let isIdOk = true;
    const maybeId = warpRouteIdFromFileName(
      warpDeployConfigFileName,
      addWarpRouteOptions.symbol,
    );
    try {
      BaseRegistry.warpDeployConfigToId(warpDeployConfig, {
        warpRouteId: maybeId,
      });
    } catch {
      isIdOk = false;
      warnYellow(
        `Generated id "${maybeId}" from input config file would be invalid, falling back to default options`,
      );
    }

    warpRouteIdOptions = isIdOk
      ? { warpRouteId: maybeId }
      : addWarpRouteOptions;
  } else {
    warpRouteIdOptions = addWarpRouteOptions;
  }

  await writeDeploymentArtifacts(warpCoreConfig, context, warpRouteIdOptions);

  await completeDeploy(
    context,
    'warp',
    initialBalances,
    null,
    deploymentChains,
  );
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
): Promise<{
  deployedContracts: ChainMap<Address>;
  deployments: WarpCoreConfig;
}> {
  logBlue('🚀 All systems ready, captain! Beginning deployment...');

  const {
    warpDeployConfig,
    context: { multiProvider, isDryRun, dryRunChain, multiProtocolSigner },
  } = params;

  const config: WarpRouteDeployConfigMailboxRequired =
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
  // Then return a modified config with the ism and/or hook address as a string
  const modifiedConfig = await resolveWarpIsmAndHook(
    config,
    params.context,
    ismFactoryDeployer,
    contractVerifier,
  );

  let deployedContracts: ChainMap<Address> = {};
  const deployments: WarpCoreConfig = { tokens: [] };

  // get unique list of protocols
  const protocols = Array.from(
    new Set(
      Object.keys(modifiedConfig).map((chainName) =>
        multiProvider.getProtocol(chainName),
      ),
    ),
  );

  for (const protocol of protocols) {
    const protocolSpecificConfig = objFilter(
      modifiedConfig,
      (chainName, _): _ is any =>
        multiProvider.getProtocol(chainName) === protocol,
    );

    if (isObjEmpty(protocolSpecificConfig)) {
      continue;
    }

    switch (protocol) {
      case ProtocolType.Ethereum: {
        const deployer = warpDeployConfig.isNft
          ? new HypERC721Deployer(multiProvider)
          : new HypERC20Deployer(multiProvider); // TODO: replace with EvmERC20WarpModule

        const evmContracts = await deployer.deploy(protocolSpecificConfig);
        deployedContracts = {
          ...deployedContracts,
          ...objMap(
            evmContracts as HyperlaneContractsMap<HypERC20Factories>,
            (_, contracts) => getRouter(contracts).address,
          ),
        };

        break;
      }
      case ProtocolType.CosmosNative: {
        const signersMap = objMap(
          protocolSpecificConfig,
          (chain, _) => multiProtocolSigner!.getCosmosNativeSigner(chain)!,
        );

        const deployer = new CosmosNativeDeployer(multiProvider, signersMap);
        deployedContracts = {
          ...deployedContracts,
          ...(await deployer.deploy(protocolSpecificConfig)),
        };

        break;
      }
      default: {
        throw new Error(`Protocol type ${protocol} not supported`);
      }
    }
  }

  const { warpCoreConfig } = await getWarpCoreConfig(
    { context: params.context, warpDeployConfig: modifiedConfig },
    deployedContracts,
  );

  deployments.tokens = [...deployments.tokens, ...warpCoreConfig.tokens];
  deployments.options = {
    ...deployments.options,
    ...warpCoreConfig.options,
  };

  logGreen('✅ Warp contract deployments complete');
  return { deployedContracts, deployments };
}

async function writeDeploymentArtifacts(
  warpCoreConfig: WarpCoreConfig,
  context: WriteCommandContext,
  addWarpRouteOptions?: AddWarpRouteConfigOptions,
) {
  if (!context.isDryRun) {
    log('Writing deployment artifacts...');
    await context.registry.addWarpRoute(warpCoreConfig, addWarpRouteOptions);
  }
  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
}

async function resolveWarpIsmAndHook(
  warpConfig: WarpRouteDeployConfigMailboxRequired,
  context: WriteCommandContext,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
  contractVerifier?: ContractVerifier,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      const registryAddresses = await context.registry.getAddresses();
      const ccipContractCache = new CCIPContractCache(registryAddresses);
      const chainAddresses = registryAddresses[chain];

      if (!chainAddresses) {
        throw `Registry factory addresses not found for ${chain}.`;
      }

      config.interchainSecurityModule = await createWarpIsm({
        ccipContractCache,
        chain,
        chainAddresses,
        context,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      }); // TODO write test

      config.hook = await createWarpHook({
        ccipContractCache,
        chain,
        chainAddresses,
        context,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      });
      return config;
    }),
  );
}

/**
 * Deploys the Warp ISM for a given config
 *
 * @returns The deployed ism address
 */
async function createWarpIsm({
  ccipContractCache,
  chain,
  chainAddresses,
  context,
  contractVerifier,
  warpConfig,
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  context: WriteCommandContext;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
}): Promise<IsmConfig | undefined> {
  const { interchainSecurityModule } = warpConfig;
  if (
    !interchainSecurityModule ||
    typeof interchainSecurityModule === 'string'
  ) {
    logGray(
      `Config Ism is ${
        !interchainSecurityModule ? 'empty' : interchainSecurityModule
      }, skipping deployment.`,
    );
    return interchainSecurityModule;
  }

  logBlue(`Loading registry factory addresses for ${chain}...`);

  logGray(
    `Creating ${interchainSecurityModule.type} ISM for token on ${chain} chain...`,
  );

  logGreen(
    `Finished creating ${interchainSecurityModule.type} ISM for token on ${chain} chain.`,
  );

  const protocolType = context.multiProvider.getProtocol(chain);

  switch (protocolType) {
    case ProtocolType.Ethereum: {
      const evmIsmModule = await EvmIsmModule.create({
        chain,
        mailbox: chainAddresses.mailbox,
        multiProvider: context.multiProvider,
        proxyFactoryFactories:
          extractIsmAndHookFactoryAddresses(chainAddresses),
        config: interchainSecurityModule,
        ccipContractCache,
        contractVerifier,
      });
      const { deployedIsm } = evmIsmModule.serialize();
      return deployedIsm;
    }
    case ProtocolType.CosmosNative: {
      const signer = context.multiProtocolSigner!.getCosmosNativeSigner(chain);

      const cosmosIsmModule = await CosmosNativeIsmModule.create({
        chain,
        multiProvider: context.multiProvider,
        addresses: {
          deployedIsm: '',
          mailbox: chainAddresses.mailbox,
        },
        config: interchainSecurityModule,
        signer,
      });
      const { deployedIsm } = cosmosIsmModule.serialize();
      return deployedIsm;
    }
    default:
      throw new Error(`Protocol type ${protocolType} not supported`);
  }
}

async function createWarpHook({
  ccipContractCache,
  chain,
  chainAddresses,
  context,
  contractVerifier,
  warpConfig,
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  context: WriteCommandContext;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
}): Promise<HookConfig | undefined> {
  const { hook } = warpConfig;

  if (!hook || typeof hook === 'string') {
    logGray(`Config Hook is ${!hook ? 'empty' : hook}, skipping deployment.`);
    return hook;
  }

  logBlue(`Loading registry factory addresses for ${chain}...`);

  logGray(`Creating ${hook.type} Hook for token on ${chain} chain...`);

  const protocolType = context.multiProvider.getProtocol(chain);

  switch (protocolType) {
    case ProtocolType.Ethereum: {
      logBlue(`Loading registry factory addresses for ${chain}...`);

      logGray(`Creating ${hook.type} Hook for token on ${chain} chain...`);

      // If config.proxyadmin.address exists, then use that. otherwise deploy a new proxyAdmin
      const proxyAdminAddress: Address =
        warpConfig.proxyAdmin?.address ??
        (
          await context.multiProvider.handleDeploy(
            chain,
            new ProxyAdmin__factory(),
            [],
          )
        ).address;

      const evmHookModule = await EvmHookModule.create({
        chain,
        multiProvider: context.multiProvider,
        coreAddresses: {
          mailbox: chainAddresses.mailbox,
          proxyAdmin: proxyAdminAddress,
        },
        config: hook,
        ccipContractCache,
        contractVerifier,
        proxyFactoryFactories:
          extractIsmAndHookFactoryAddresses(chainAddresses),
      });
      logGreen(
        `Finished creating ${hook.type} Hook for token on ${chain} chain.`,
      );
      const { deployedHook } = evmHookModule.serialize();
      return deployedHook;
    }
    case ProtocolType.CosmosNative: {
      logBlue(`No warp hooks for Cosmos Native chains, skipping deployment.`);
      return hook;
    }
    default:
      throw new Error(`Protocol type ${protocolType} not supported`);
  }
}

async function getWarpCoreConfig(
  params: DeployParams,
  contracts: ChainMap<Address>,
): Promise<{
  warpCoreConfig: WarpCoreConfig;
  addWarpRouteOptions: AddWarpRouteConfigOptions;
}> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadataMap: TokenMetadataMap =
    await HypERC20Deployer.deriveTokenMetadata(
      params.context.multiProvider,
      params.warpDeployConfig,
    );

  generateTokenConfigs(
    params.context.multiProvider,
    warpCoreConfig,
    params.warpDeployConfig,
    contracts,
    tokenMetadataMap,
  );

  fullyConnectTokens(warpCoreConfig, params.context.multiProvider);

  const symbol = tokenMetadataMap.getDefaultSymbol();

  return { warpCoreConfig, addWarpRouteOptions: { symbol } };
}

/**
 * Creates token configs.
 */
function generateTokenConfigs(
  multiProvider: MultiProvider,
  warpCoreConfig: WarpCoreConfig,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  contracts: ChainMap<Address>,
  tokenMetadataMap: TokenMetadataMap,
): void {
  for (const chainName of Object.keys(contracts)) {
    const config = warpDeployConfig[chainName];
    const collateralAddressOrDenom =
      isCollateralTokenConfig(config) || isXERC20TokenConfig(config)
        ? config.token // gets set in the above deriveTokenMetadata()
        : undefined;

    const protocol = multiProvider.getProtocol(chainName);

    warpCoreConfig.tokens.push({
      chainName,
      standard: tokenTypeToStandard(protocol as ProtocolType, config.type),
      decimals: tokenMetadataMap.getDecimals(chainName)!,
      symbol: config.symbol || tokenMetadataMap.getSymbol(chainName)!,
      name: tokenMetadataMap.getName(chainName)!,
      addressOrDenom: contracts[chainName],
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
function fullyConnectTokens(
  warpCoreConfig: WarpCoreConfig,
  multiProvider: MultiProvider,
): void {
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
          multiProvider.getProtocol(token2.chainName),
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
  const { chainMetadata, skipConfirmation } = context;

  WarpRouteDeployConfigSchema.parse(warpDeployConfig);
  WarpCoreConfigSchema.parse(warpCoreConfig);

  const chains = Object.keys(warpDeployConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(
      chains,
      chainMetadata,
      context.registry,
    );

  const { multiProvider } = context;
  // temporarily configure deployer as owner so that warp update after extension
  // can leverage JSON RPC submitter on new chains
  const intermediateOwnerConfig = await promiseObjAll(
    objMap(params.warpDeployConfig, async (chain, config) => {
      const protocolType = multiProvider.getProtocol(chain);

      if (protocolType !== ProtocolType.Ethereum) {
        return config;
      }

      return {
        ...config,
        owner: await multiProvider.getSignerAddress(chain),
      };
    }),
  );

  // Extend the warp route and get the updated configs
  const updatedWarpCoreConfig = await extendWarpRoute(
    { ...params, warpDeployConfig: intermediateOwnerConfig },
    apiKeys,
    warpCoreConfig,
  );

  // Then create and submit update transactions
  const transactions: AnnotatedEV5Transaction[] = await updateExistingWarpRoute(
    params,
    apiKeys,
    warpDeployConfig,
    updatedWarpCoreConfig,
  );

  if (transactions.length == 0)
    return logGreen(`Warp config is the same as target. No updates needed.`);
  await submitWarpApplyTransactions(params, groupBy(transactions, 'chainId'));
}

/**
 * Handles the deployment and configuration of new contracts for extending a Warp route.
 * This function performs several key steps:
 * 1. Derives metadata from existing contracts and applies it to new configurations
 * 2. Deploys new contracts using the derived configurations
 * 3. Merges existing and new router configurations
 * 4. Generates an updated Warp core configuration
 */
async function deployWarpExtensionContracts(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  existingConfigs: WarpRouteDeployConfigMailboxRequired,
  initialExtendedConfigs: WarpRouteDeployConfigMailboxRequired,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
) {
  // Deploy new contracts with derived metadata
  const extendedConfigs = await deriveMetadataFromExisting(
    params.context.multiProvider,
    existingConfigs,
    initialExtendedConfigs,
  );

  const { deployedContracts: newDeployedContracts } = await executeDeploy(
    {
      context: params.context,
      warpDeployConfig: extendedConfigs,
    },
    apiKeys,
  );

  // Merge existing and new routers
  const mergedRouters = mergeAllRouters(
    existingConfigs,
    newDeployedContracts,
    warpCoreConfigByChain,
  );

  // Get the updated core config
  const { warpCoreConfig: updatedWarpCoreConfig, addWarpRouteOptions } =
    await getWarpCoreConfig(params, mergedRouters);
  WarpCoreConfigSchema.parse(updatedWarpCoreConfig);

  return {
    newDeployedContracts,
    updatedWarpCoreConfig,
    addWarpRouteOptions,
  };
}

/**
 * Splits warp configs into existing and extended, and returns details about the extension.
 * @param warpCoreConfig The warp core config.
 * @param warpDeployConfig The warp deploy config.
 * @returns An object containing the split configs, extended chains, and warp core config by chain.
 */
function getWarpRouteExtensionDetails(
  warpCoreConfig: WarpCoreConfig,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
) {
  const warpCoreConfigByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );
  const warpCoreChains = Object.keys(warpCoreConfigByChain);

  // Split between the existing and additional config
  const [existingConfigs, initialExtendedConfigs] =
    splitWarpCoreAndExtendedConfigs(warpDeployConfig, warpCoreChains);

  const extendedChains = Object.keys(initialExtendedConfigs);

  return {
    existingConfigs,
    initialExtendedConfigs,
    extendedChains,
    warpCoreConfigByChain,
  };
}

/**
 * Extends an existing Warp route to include new chains.
 * This function manages the entire extension workflow:
 * 1. Divides the configuration into existing and new chain segments.
 * 2. Returns the current configuration if no new chains are added.
 * 3. Deploys and sets up new contracts for the additional chains.
 * 4. Refreshes the Warp core configuration with updated token details.
 * 5. Saves the revised artifacts to the registry.
 */
export async function extendWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpCoreConfig: WarpCoreConfig,
): Promise<WarpCoreConfig> {
  const { context, warpDeployConfig } = params;
  const {
    existingConfigs,
    initialExtendedConfigs,
    extendedChains,
    warpCoreConfigByChain,
  } = getWarpRouteExtensionDetails(warpCoreConfig, warpDeployConfig);

  const filteredExtendedConfigs = Object.fromEntries(
    Object.entries(initialExtendedConfigs).filter(
      ([chainName]) =>
        context.multiProtocolProvider.getProtocol(chainName) ===
        ProtocolType.Ethereum,
    ),
  );

  const filteredExtendedChains = Object.keys(filteredExtendedConfigs);
  if (extendedChains.length === 0) {
    return warpCoreConfig;
  }

  logBlue(`Extending Warp Route to ${filteredExtendedChains.join(', ')}`);

  // Deploy new contracts with derived metadata and merge with existing config
  const { updatedWarpCoreConfig, addWarpRouteOptions } =
    await deployWarpExtensionContracts(
      params,
      apiKeys,
      existingConfigs,
      filteredExtendedConfigs,
      warpCoreConfigByChain,
    );

  // Write the updated artifacts
  await writeDeploymentArtifacts(
    updatedWarpCoreConfig,
    context,
    params.warpRouteId
      ? { warpRouteId: params.warpRouteId } // Use warpRouteId if provided, otherwise use the warpCoreConfig symbol
      : addWarpRouteOptions,
  );

  return updatedWarpCoreConfig;
}

// Updates Warp routes with new configurations.
async function updateExistingWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  warpCoreConfig: WarpCoreConfig,
) {
  logBlue('Updating deployed Warp Routes');
  const { multiProvider, registry } = params.context;
  const registryAddresses =
    (await registry.getAddresses()) as ChainMap<ChainAddresses>;
  const ccipContractCache = new CCIPContractCache(registryAddresses);
  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );
  const transactions: AnnotatedEV5Transaction[] = [];

  // Get all deployed router addresses
  const deployedRoutersAddresses =
    getRouterAddressesFromWarpCoreConfig(warpCoreConfig);

  const expandedWarpDeployConfig = await expandWarpDeployConfig({
    multiProvider,
    warpDeployConfig,
    deployedRoutersAddresses,
  });

  await promiseObjAll(
    objMap(expandedWarpDeployConfig, async (chain, config) => {
      if (multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
        logBlue(`Skipping non-EVM chain ${chain}`);
        return;
      }

      await retryAsync(async () => {
        const deployedTokenRoute = deployedRoutersAddresses[chain];
        assert(deployedTokenRoute, `Missing artifacts for ${chain}.`);
        const configWithMailbox = {
          ...config,
          mailbox: registryAddresses[chain].mailbox,
        };

        const evmERC20WarpModule = new EvmERC20WarpModule(
          multiProvider,
          {
            config: configWithMailbox,
            chain,
            addresses: {
              deployedTokenRoute,
              ...extractIsmAndHookFactoryAddresses(registryAddresses[chain]),
            },
          },
          ccipContractCache,
          contractVerifier,
        );
        transactions.push(
          ...(await evmERC20WarpModule.update(configWithMailbox)),
        );
      });
    }),
  );
  return transactions;
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
  existingConfigs: WarpRouteDeployConfigMailboxRequired,
  extendedConfigs: WarpRouteDeployConfigMailboxRequired,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  const existingTokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    multiProvider,
    existingConfigs,
  );

  return objMap(extendedConfigs, (_chain, extendedConfig) => {
    return {
      ...existingTokenMetadata.getMetadataForChain(_chain),
      ...extendedConfig,
    };
  });
}

/**
 * Merges existing router configs with newly deployed router contracts.
 */
function mergeAllRouters(
  existingConfigs: WarpRouteDeployConfigMailboxRequired,
  deployedContractsMap: ChainMap<Address>,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
): ChainMap<Address> {
  let result: ChainMap<Address> = {};

  for (const chain of Object.keys(existingConfigs)) {
    result = {
      ...result,
      [chain]: warpCoreConfigByChain[chain].addressOrDenom!,
    };
  }

  return {
    ...result,
    ...deployedContractsMap,
  };
}

function displayWarpDeployPlan(
  deployConfig: WarpRouteDeployConfigMailboxRequired,
) {
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
type IsmDisplayConfig =
  | RoutingIsmConfig // type, owner, ownerOverrides, domain
  | AggregationIsmConfig // type, modules, threshold
  | MultisigIsmConfig // type, validators, threshold
  | OpStackIsmConfig // type, origin, nativeBridge
  | PausableIsmConfig // type, owner, paused, ownerOverrides
  | TrustedRelayerIsmConfig; // type, relayer

function transformDeployConfigForDisplay(
  deployConfig: WarpRouteDeployConfigMailboxRequired,
) {
  const transformedIsmConfigs: Record<ChainName, any[]> = {};
  const transformedDeployConfig = objMap(deployConfig, (chain, config) => {
    if (config.interchainSecurityModule)
      transformedIsmConfigs[chain] = transformIsmConfigForDisplay(
        config.interchainSecurityModule as IsmDisplayConfig,
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

function transformIsmConfigForDisplay(ismConfig: IsmDisplayConfig): any[] {
  const ismConfigs: any[] = [];
  switch (ismConfig.type) {
    case IsmType.AGGREGATION:
      ismConfigs.push({
        Type: ismConfig.type,
        Threshold: ismConfig.threshold,
        Modules: 'See table(s) below.',
      });
      ismConfig.modules.forEach((module) => {
        ismConfigs.push(
          ...transformIsmConfigForDisplay(module as IsmDisplayConfig),
        );
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
  params: WarpApplyParams,
  chainTransactions: Record<string, AnnotatedEV5Transaction[]>,
): Promise<void> {
  // Create mapping of chain ID to chain name for all chains in warpDeployConfig
  const chains = Object.keys(params.warpDeployConfig);
  const chainIdToName = Object.fromEntries(
    chains.map((chain) => [
      params.context.multiProvider.getChainId(chain),
      chain,
    ]),
  );

  const { extendedChains } = getWarpRouteExtensionDetails(
    params.warpCoreConfig,
    params.warpDeployConfig,
  );

  await promiseObjAll(
    objMap(chainTransactions, async (chainId, transactions) => {
      try {
        await retryAsync(
          async () => {
            const chain = chainIdToName[chainId];
            const isExtendedChain = extendedChains.includes(chain);
            const { submitter, config } = await getWarpApplySubmitter({
              chain,
              context: params.context,
              strategyUrl: params.strategyUrl,
              isExtendedChain,
            });
            const transactionReceipts = await submitter.submit(...transactions);
            if (transactionReceipts) {
              const receiptPath = `${params.receiptsDir}/${chain}-${
                submitter.txSubmitterType
              }-${Date.now()}-receipts.json`;
              writeYamlOrJson(receiptPath, transactionReceipts);
              logGreen(
                `Transactions receipts successfully written to ${receiptPath}`,
              );
            }

            const canRelay = canSelfRelay(
              params.selfRelay ?? false,
              config,
              transactionReceipts,
            );

            if (!canRelay.relay) {
              return;
            }

            // if self relaying does not work (possibly because metadata cannot be built yet)
            // we don't want to rerun the complete code block as this will result in
            // the update transactions being sent multiple times
            try {
              await retryAsync(() =>
                runSelfRelay({
                  txReceipt: canRelay.txReceipt,
                  multiProvider: params.context.multiProvider,
                  registry: params.context.registry,
                  successMessage: WarpSendLogs.SUCCESS,
                }),
              );
            } catch (error) {
              warnYellow(`Error when self-relaying Warp transaction`, error);
            }
          },
          5, // attempts
          100, // baseRetryMs
        );
      } catch (e) {
        logBlue(`Error in submitWarpApplyTransactions`, e);
        console.dir(transactions);
      }
    }),
  );
}

/**
 * Helper function to get warp apply specific submitter.
 *
 * @returns the warp apply submitter
 */
async function getWarpApplySubmitter<T extends ProtocolType>({
  chain,
  context,
  strategyUrl,
  isExtendedChain,
}: {
  chain: ChainName;
  context: WriteCommandContext;
  strategyUrl?: string;
  isExtendedChain?: boolean;
}): Promise<{
  submitter: TxSubmitterBuilder<T>;
  config: SubmissionStrategy;
}> {
  const { multiProvider, registry } = context;

  const submissionStrategy: SubmissionStrategy =
    strategyUrl && !isExtendedChain
      ? readChainSubmissionStrategy(strategyUrl)[chain]
      : {
          submitter: {
            chain,
            type: TxSubmitterType.JSON_RPC,
          },
        };

  return {
    submitter: await getSubmitterBuilder<T>({
      submissionStrategy: SubmissionStrategySchema.parse(submissionStrategy),
      multiProvider,
      registry,
    }),
    config: submissionStrategy,
  };
}

async function enrollCrossChainRouters(
  {
    context,
    warpDeployConfig,
  }: {
    context: WriteCommandContext;
    warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  },
  deployedContracts: ChainMap<Address>,
) {
  const resolvedConfigMap = objMap(warpDeployConfig, (_, config) => ({
    gas: 0, // TODO: protocol specific gas?,
    ...config,
  }));

  const configMapToDeploy = objFilter(
    resolvedConfigMap,
    (_, config: any): config is any => !config.foreignDeployment,
  );

  const allChains = Object.keys(configMapToDeploy);

  for (const chain of allChains) {
    const protocol = context.multiProvider.getProtocol(chain);

    const allRemoteChains = context.multiProvider
      .getRemoteChains(chain)
      .filter((c) => allChains.includes(c));

    const protocolTransactions = {} as GroupedTransactions;

    switch (protocol) {
      case ProtocolType.Ethereum: {
        const registryAddresses = await context.registry.getAddresses();
        const {
          domainRoutingIsmFactory,
          staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory,
          staticAggregationIsmFactory,
          staticAggregationHookFactory,
          staticMerkleRootWeightedMultisigIsmFactory,
          staticMessageIdWeightedMultisigIsmFactory,
        } = registryAddresses[chain];

        const evmWarpModule = new EvmERC20WarpModule(context.multiProvider, {
          chain,
          config: configMapToDeploy[chain],
          addresses: {
            deployedTokenRoute: deployedContracts[chain],
            domainRoutingIsmFactory,
            staticMerkleRootMultisigIsmFactory,
            staticMessageIdMultisigIsmFactory,
            staticAggregationIsmFactory,
            staticAggregationHookFactory,
            staticMerkleRootWeightedMultisigIsmFactory,
            staticMessageIdWeightedMultisigIsmFactory,
          },
        });

        const actualConfig = await evmWarpModule.read();
        const expectedConfig = {
          ...actualConfig,
          remoteRouters: (() => {
            const routers: Record<string, { address: string }> = {};
            for (const c of allRemoteChains) {
              routers[context.multiProvider.getDomainId(c).toString()] = {
                address: deployedContracts[c],
              };
            }
            return routers;
          })(),
        };

        const transactions = await evmWarpModule.update(expectedConfig);

        if (transactions.length) {
          protocolTransactions[ProtocolType.Ethereum] = {
            [chain]: transactions,
          };
        }

        break;
      }
      case ProtocolType.CosmosNative: {
        const signer =
          context.multiProtocolSigner!.getCosmosNativeSigner(chain);

        const cosmosNativeWarpModule = new CosmosNativeWarpModule(
          context.multiProvider,
          {
            chain,
            config: configMapToDeploy[chain],
            addresses: {
              deployedTokenRoute: deployedContracts[chain],
            },
          },
          signer,
        );
        const actualConfig = await cosmosNativeWarpModule.read();
        const expectedConfig = {
          ...actualConfig,
          remoteRouters: (() => {
            const routers: Record<string, { address: string }> = {};
            for (const c of allRemoteChains) {
              routers[context.multiProvider.getDomainId(c).toString()] = {
                address: deployedContracts[c],
              };
            }
            return routers;
          })(),
        };

        const transactions =
          await cosmosNativeWarpModule.update(expectedConfig);

        if (transactions.length) {
          protocolTransactions[ProtocolType.CosmosNative] = {
            [chain]: transactions,
          };
        }

        break;
      }
      default: {
        throw new Error(`Protocol type ${protocol} not supported`);
      }
    }
  }
}

function getRouter(contracts: HyperlaneContracts<HypERC20Factories>) {
  for (const key of objKeys(hypERC20factories)) {
    if (contracts[key]) return contracts[key];
  }
  throw new Error('No matching contract found.');
}
