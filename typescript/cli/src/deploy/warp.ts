import { confirm } from '@inquirer/prompts';
import { groupBy } from 'lodash-es';
import { Account as StarknetAccount } from 'starknet';
import { stringify as yamlStringify } from 'yaml';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { AddWarpRouteOptions, ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  AnnotatedEV5Transaction,
  CCIPContractCache,
  ChainMap,
  ChainName,
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  ContractVerifier,
  DestinationGas,
  EvmERC20WarpModule,
  EvmERC20WarpRouteReader,
  EvmHookModule,
  EvmIsmModule,
  ExplorerLicenseType,
  HookConfig,
  HypERC20Deployer,
  HypERC20Factories,
  HypERC721Deployer,
  HypERC721Factories,
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
  RemoteRouters,
  RoutingIsmConfig,
  STARKNET_SUPPORTED_TOKEN_TYPES,
  STARKNET_TOKEN_TYPE_TO_STANDARD,
  StarknetERC20WarpModule,
  SubmissionStrategy,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TokenType,
  TrustedRelayerIsmConfig,
  TxSubmitterBuilder,
  TxSubmitterType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
  attachContractsMap,
  connectContractsMap,
  getTokenConnectionId,
  hypERC20factories,
  isCollateralTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { readWarpRouteDeployConfig } from '../config/warp.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { MultiProtocolSignerManager } from '../context/strategies/signer/MultiProtocolSignerManager.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen, logTable } from '../logger.js';
import { getSubmitterBuilder } from '../submit/submit.js';
import {
  indentYamlOrJson,
  isFile,
  readYamlOrJson,
  runFileSelectionStep,
  writeYamlOrJson,
} from '../utils/files.js';

import { prepareDeploy, runPreflightChecksForChains } from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}

interface WarpApplyParams extends DeployParams {
  warpCoreConfig: WarpCoreConfig;
  strategyUrl?: string;
  receiptsDir: string;
}

export async function runWarpRouteDeploy({
  context,
  warpRouteDeploymentConfigPath,
  multiProtocolSigner,
}: {
  context: WriteCommandContext;
  warpRouteDeploymentConfigPath?: string;
  multiProtocolSigner?: MultiProtocolSignerManager;
}) {
  const { skipConfirmation, chainMetadata, registry } = context;
  const multiProvider = await multiProtocolSigner?.getMultiProvider();
  assert(multiProvider, 'Multiprovider failed!');

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
    apiKeys = await requestAndSaveApiKeys(chains, chainMetadata, registry);

  warpRouteConfig.paradexsepolia.interchainSecurityModule = undefined;
  warpRouteConfig.starknetsepolia.interchainSecurityModule = undefined;

  console.log('warpRouteConfig', warpRouteConfig);
  // warpRouteConfig.starknetsepolia.interchainSecurityModule =
  //   '0x04b96481bd6b1c5fec5d41b0c17581a56ef212c4fb2a7248309992a962de5649';

  await runDeployPlanStep({
    context,
    warpDeployConfig: warpRouteConfig,
  });

  const chainsByProtocol = groupChainsByProtocol(chains, multiProvider);
  const deployments: WarpCoreConfig = { tokens: [] };
  let deploymentAddWarpRouteOptions: AddWarpRouteOptions | undefined;

  const routerAddresses: {
    evm: ChainMap<Address>;
    starknet: ChainMap<Address>;
  } = {
    evm: {},
    starknet: {},
  };

  let starknetSigners: ChainMap<StarknetAccount> = {};

  // Execute deployments for each protocol
  for (const protocol of Object.keys(chainsByProtocol) as ProtocolType[]) {
    const protocolChains = chainsByProtocol[protocol];

    switch (protocol) {
      case ProtocolType.Ethereum:
        {
          await runPreflightChecksForChains({
            context,
            chains: protocolChains,
            minGas: MINIMUM_WARP_DEPLOY_GAS,
          });
          await prepareDeploy(context, null, protocolChains);
          const deployedContracts = await executeDeploy(
            { context, warpDeployConfig: warpRouteConfig },
            apiKeys,
          );

          // Store EVM router addresses
          routerAddresses.evm = objMap(
            deployedContracts as HyperlaneContractsMap<HypERC20Factories>,
            (_, contracts) => getRouter(contracts).address,
          );

          const { warpCoreConfig, addWarpRouteOptions } =
            await getWarpCoreConfig(
              { context, warpDeployConfig: warpRouteConfig },
              deployedContracts,
            );
          deploymentAddWarpRouteOptions = addWarpRouteOptions;
          deployments.tokens = [
            ...deployments.tokens,
            ...warpCoreConfig.tokens,
          ];
          deployments.options = {
            ...deployments.options,
            ...warpCoreConfig.options,
          };
          console.log('ETH WARPCORECONFIG', warpCoreConfig);
        }

        break;

      case ProtocolType.Starknet:
        assert(
          multiProtocolSigner,
          'multi protocol signer is required for starknet chain deployment',
        );
        starknetSigners = protocolChains.reduce<ChainMap<StarknetAccount>>(
          (acc, chain) => ({
            ...acc,
            [chain]: multiProtocolSigner.getStarknetSigner(chain),
          }),
          {},
        );
        routerAddresses.starknet = await executeStarknetDeployments({
          starknetSigners,
          warpRouteConfig,
          multiProvider,
        });
        const { warpCoreConfig, addWarpRouteOptions } =
          await getWarpCoreConfigForStarknet(
            warpRouteConfig,
            multiProvider,
            routerAddresses.starknet,
          );
        deploymentAddWarpRouteOptions = addWarpRouteOptions;
        deployments.tokens = [...deployments.tokens, ...warpCoreConfig.tokens];
        console.log('STARKNET WARPCORECONFIG', warpCoreConfig);
        break;
        throw new Error('test');

      default:
        throw new Error(`Unsupported protocol type: ${protocol}`);
    }
  }

  await enrollCrossChainRouters({
    evmAddresses: routerAddresses.evm,
    starknetAddresses: routerAddresses.starknet,
    context,
    warpRouteConfig,
    deployments,
    multiProvider,
    starknetSigners,
  });

  fullyConnectTokens(deployments, context.multiProvider);
  await writeDeploymentArtifacts(
    deployments,
    context,
    deploymentAddWarpRouteOptions,
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
): Promise<HyperlaneContractsMap<HypERC20Factories | HypERC721Factories>> {
  logBlue('🚀 All systems ready, captain! Beginning deployment...');

  const {
    warpDeployConfig,
    context: { multiProvider, isDryRun, dryRunChain },
  } = params;

  const deployer = warpDeployConfig.isNft
    ? new HypERC721Deployer(multiProvider)
    : new HypERC20Deployer(multiProvider); // TODO: replace with EvmERC20WarpModule

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

  const deployedContracts = await deployer.deploy(modifiedConfig);

  logGreen('✅ Warp contract deployments complete');
  return deployedContracts;
}

async function writeDeploymentArtifacts(
  warpCoreConfig: WarpCoreConfig,
  context: WriteCommandContext,
  addWarpRouteOptions?: AddWarpRouteOptions,
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
      if (
        // for non-evm chains just return config as it is
        context.multiProvider.getChainMetadata(chain).protocol !==
          ProtocolType.Ethereum ||
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

  const {
    mailbox,
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory,
  } = chainAddresses;
  const evmIsmModule = await EvmIsmModule.create({
    chain,
    mailbox,
    multiProvider: context.multiProvider,
    proxyFactoryFactories: {
      domainRoutingIsmFactory,
      staticAggregationHookFactory,
      staticAggregationIsmFactory,
      staticMerkleRootMultisigIsmFactory,
      staticMessageIdMultisigIsmFactory,
      staticMerkleRootWeightedMultisigIsmFactory,
      staticMessageIdWeightedMultisigIsmFactory,
    },
    config: interchainSecurityModule,
    ccipContractCache,
    contractVerifier,
  });
  const { deployedIsm } = evmIsmModule.serialize();
  return deployedIsm;
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

  const {
    mailbox,
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory,
  } = chainAddresses;
  const proxyFactoryFactories = {
    domainRoutingIsmFactory,
    staticAggregationHookFactory,
    staticAggregationIsmFactory,
    staticMerkleRootMultisigIsmFactory,
    staticMessageIdMultisigIsmFactory,
    staticMerkleRootWeightedMultisigIsmFactory,
    staticMessageIdWeightedMultisigIsmFactory,
  };

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
      mailbox,
      proxyAdmin: proxyAdminAddress,
    },
    config: hook,
    ccipContractCache,
    contractVerifier,
    proxyFactoryFactories,
  });
  logGreen(`Finished creating ${hook.type} Hook for token on ${chain} chain.`);
  const { deployedHook } = evmHookModule.serialize();
  return deployedHook;
}

async function getWarpCoreConfigCore<T>(
  warpDeployConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  contracts: T,
  generateConfigsFn: (
    warpCoreConfig: WarpCoreConfig,
    warpDeployConfig: WarpRouteDeployConfig,
    contracts: T,
    symbol: string,
    name: string,
    decimals: number,
  ) => void,
): Promise<{
  warpCoreConfig: WarpCoreConfig;
  addWarpRouteOptions?: AddWarpRouteOptions;
}> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    multiProvider,
    warpDeployConfig,
  );
  assert(
    tokenMetadata && isTokenMetadata(tokenMetadata),
    'Missing required token metadata',
  );
  const { decimals, symbol, name } = tokenMetadata;
  assert(decimals, 'Missing decimals on token metadata');

  generateConfigsFn(
    warpCoreConfig,
    warpDeployConfig,
    contracts,
    symbol,
    name,
    decimals,
  );

  fullyConnectTokens(warpCoreConfig, multiProvider);

  return { warpCoreConfig, addWarpRouteOptions: { symbol } };
}

async function getWarpCoreConfig(
  { warpDeployConfig, context }: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): Promise<{
  warpCoreConfig: WarpCoreConfig;
  addWarpRouteOptions?: AddWarpRouteOptions;
}> {
  return getWarpCoreConfigCore(
    warpDeployConfig,
    context.multiProvider,
    contracts,
    generateTokenConfigs,
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
    const collateralAddressOrDenom =
      isCollateralTokenConfig(config) || isXERC20TokenConfig(config)
        ? config.token // gets set in the above deriveTokenMetadata()
        : undefined;

    warpCoreConfig.tokens.push({
      chainName,
      standard: TOKEN_TYPE_TO_STANDARD[config.type],
      decimals,
      symbol: config.symbol || symbol,
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
          multiProvider.getChainMetadata(token2.chainName).protocol,
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

  const warpCoreConfigByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );

  const chains = Object.keys(warpDeployConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(
      chains,
      chainMetadata,
      context.registry,
    );

  const transactions: AnnotatedEV5Transaction[] = [
    ...(await extendWarpRoute(
      params,
      apiKeys,
      warpDeployConfig,
      warpCoreConfigByChain,
    )),
    ...(await updateExistingWarpRoute(
      params,
      apiKeys,
      warpDeployConfig,
      warpCoreConfigByChain,
    )),
  ];
  if (transactions.length == 0)
    return logGreen(`Warp config is the same as target. No updates needed.`);

  await submitWarpApplyTransactions(params, groupBy(transactions, 'chainId'));
}

async function extendWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
) {
  const { multiProvider } = params.context;
  const warpCoreChains = Object.keys(warpCoreConfigByChain);

  // Split between the existing and additional config
  const existingConfigs: WarpRouteDeployConfigMailboxRequired = objFilter(
    warpDeployConfig,
    (chain, _config): _config is any => warpCoreChains.includes(chain),
  );

  let extendedConfigs: WarpRouteDeployConfigMailboxRequired = objFilter(
    warpDeployConfig,
    (chain, _config): _config is any => !warpCoreChains.includes(chain),
  );

  const extendedChains = Object.keys(extendedConfigs);
  if (extendedChains.length === 0) return [];

  logBlue(`Extending Warp Route to ${extendedChains.join(', ')}`);

  extendedConfigs = await deriveMetadataFromExisting(
    multiProvider,
    existingConfigs,
    extendedConfigs,
  );

  const newDeployedContracts = await executeDeploy(
    {
      context: params.context,
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

  const { warpCoreConfig: updatedWarpCoreConfig, addWarpRouteOptions } =
    await getWarpCoreConfig(params, mergedRouters);
  WarpCoreConfigSchema.parse(updatedWarpCoreConfig);

  await writeDeploymentArtifacts(
    updatedWarpCoreConfig,
    params.context,
    addWarpRouteOptions,
  );

  return enrollRemoteRouters(params, mergedRouters);
}

async function updateExistingWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreConfigByChain: ChainMap<WarpCoreConfig['tokens'][number]>,
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

  await promiseObjAll(
    objMap(warpDeployConfig, async (chain, config) => {
      await retryAsync(async () => {
        logGray(`Update existing warp route for chain ${chain}`);
        const deployedConfig = warpCoreConfigByChain[chain];
        if (!deployedConfig)
          return logGray(
            `Missing artifacts for ${chain}. Probably new deployment. Skipping update...`,
          );

        const deployedTokenRoute = deployedConfig.addressOrDenom!;
        const {
          domainRoutingIsmFactory,
          staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory,
          staticAggregationIsmFactory,
          staticAggregationHookFactory,
          staticMerkleRootWeightedMultisigIsmFactory,
          staticMessageIdWeightedMultisigIsmFactory,
          mailbox,
        } = registryAddresses[chain];
        const configWithMailbox = { ...config, mailbox };

        const evmERC20WarpModule = new EvmERC20WarpModule(
          multiProvider,
          {
            config: configWithMailbox,
            chain,
            addresses: {
              deployedTokenRoute,
              staticMerkleRootMultisigIsmFactory,
              staticMessageIdMultisigIsmFactory,
              staticAggregationIsmFactory,
              staticAggregationHookFactory,
              domainRoutingIsmFactory,
              staticMerkleRootWeightedMultisigIsmFactory,
              staticMessageIdWeightedMultisigIsmFactory,
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
): Promise<AnnotatedEV5Transaction[]> {
  logBlue(`Enrolling deployed routers with each other...`);
  const { multiProvider, registry } = params.context;
  const registryAddresses = await registry.getAddresses();
  const deployedRoutersAddresses: ChainMap<Address> = objMap(
    deployedContractsMap,
    (_, contracts) => getRouter(contracts).address,
  );
  const deployedDestinationGas: DestinationGas = await populateDestinationGas(
    multiProvider,
    params.warpDeployConfig,
    deployedContractsMap,
  );

  const deployedChains = Object.keys(deployedRoutersAddresses);
  const transactions: AnnotatedEV5Transaction[] = [];
  await promiseObjAll(
    objMap(deployedContractsMap, async (chain, contracts) => {
      await retryAsync(async () => {
        const router = getRouter(contracts); // Assume deployedContract always has 1 value
        const deployedTokenRoute = router.address;
        // Mutate the config.remoteRouters by setting it to all other routers to update
        const warpRouteReader = new EvmERC20WarpRouteReader(
          multiProvider,
          chain,
        );
        const mutatedWarpRouteConfig =
          await warpRouteReader.deriveWarpRouteConfig(deployedTokenRoute);
        const {
          domainRoutingIsmFactory,
          staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory,
          staticAggregationIsmFactory,
          staticAggregationHookFactory,
          staticMerkleRootWeightedMultisigIsmFactory,
          staticMessageIdWeightedMultisigIsmFactory,
        } = registryAddresses[chain];

        const evmERC20WarpModule = new EvmERC20WarpModule(multiProvider, {
          config: mutatedWarpRouteConfig,
          chain,
          addresses: {
            deployedTokenRoute,
            staticMerkleRootMultisigIsmFactory,
            staticMessageIdMultisigIsmFactory,
            staticAggregationIsmFactory,
            staticAggregationHookFactory,
            domainRoutingIsmFactory,
            staticMerkleRootWeightedMultisigIsmFactory,
            staticMessageIdWeightedMultisigIsmFactory,
          },
        });

        const otherChains = multiProvider
          .getRemoteChains(chain)
          .filter((c) => deployedChains.includes(c));

        mutatedWarpRouteConfig.remoteRouters =
          otherChains.reduce<RemoteRouters>((remoteRouters, otherChain) => {
            remoteRouters[multiProvider.getDomainId(otherChain)] = {
              address: deployedRoutersAddresses[otherChain],
            };
            return remoteRouters;
          }, {});

        mutatedWarpRouteConfig.destinationGas =
          otherChains.reduce<DestinationGas>((destinationGas, otherChain) => {
            const otherChainDomain = multiProvider.getDomainId(otherChain);
            destinationGas[otherChainDomain] =
              deployedDestinationGas[otherChainDomain];
            return destinationGas;
          }, {});

        const mutatedConfigTxs: AnnotatedEV5Transaction[] =
          await evmERC20WarpModule.update(mutatedWarpRouteConfig);

        if (mutatedConfigTxs.length == 0)
          return logGreen(
            `Warp config on ${chain} is the same as target. No updates needed.`,
          );
        transactions.push(...mutatedConfigTxs);
      });
    }),
  );

  return transactions;
}

/**
 * Populates the destination gas amounts for each chain using warpConfig.gas OR querying other router's destinationGas
 */
async function populateDestinationGas(
  multiProvider: MultiProvider,
  warpDeployConfig: WarpRouteDeployConfig,
  deployedContractsMap: HyperlaneContractsMap<HypERC20Factories>,
): Promise<DestinationGas> {
  const destinationGas: DestinationGas = {};
  const deployedChains = Object.keys(deployedContractsMap);
  await promiseObjAll(
    objMap(deployedContractsMap, async (chain, contracts) => {
      await retryAsync(async () => {
        const router = getRouter(contracts);

        const otherChains = multiProvider
          .getRemoteChains(chain)
          .filter((c) => deployedChains.includes(c));

        for (const otherChain of otherChains) {
          const otherDomain = multiProvider.getDomainId(otherChain);
          if (!destinationGas[otherDomain])
            destinationGas[otherDomain] =
              warpDeployConfig[otherChain].gas?.toString() ||
              (await router.destinationGas(otherDomain)).toString();
        }
      });
    }),
  );
  return destinationGas;
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
type IsmDisplayConfig =
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

  await promiseObjAll(
    objMap(chainTransactions, async (chainId, transactions) => {
      try {
        await retryAsync(
          async () => {
            const chain = chainIdToName[chainId];
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
              logGreen(
                `Transactions receipts successfully written to ${receiptPath}`,
              );
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
async function getWarpApplySubmitter({
  chain,
  context,
  strategyUrl,
}: {
  chain: ChainName;
  context: WriteCommandContext;
  strategyUrl?: string;
}): Promise<TxSubmitterBuilder<ProtocolType>> {
  const { multiProvider } = context;

  const submissionStrategy: SubmissionStrategy = strategyUrl
    ? readChainSubmissionStrategy(strategyUrl)[chain]
    : {
        submitter: {
          chain,
          type: TxSubmitterType.JSON_RPC,
        },
      };

  return getSubmitterBuilder<ProtocolType>({
    submissionStrategy,
    multiProvider,
  });
}

function groupChainsByProtocol(
  chains: ChainName[],
  multiProvider: MultiProvider,
): Record<ProtocolType, ChainName[]> {
  return chains.reduce((protocolMap, chainName) => {
    const protocolType = multiProvider.tryGetProtocol(chainName);
    assert(protocolType, `Protocol not found for chain: ${chainName}`);

    if (!protocolMap[protocolType]) {
      protocolMap[protocolType] = [];
    }

    protocolMap[protocolType].push(chainName);
    return protocolMap;
  }, {} as Record<ProtocolType, ChainName[]>);
}

async function executeStarknetDeployments({
  starknetSigners,
  warpRouteConfig,
  multiProvider,
}: {
  starknetSigners: ChainMap<StarknetAccount>;
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired;
  multiProvider: MultiProvider;
}): Promise<ChainMap<string>> {
  validateStarknetWarpConfig(warpRouteConfig);

  const starknetDeployer = new StarknetERC20WarpModule(
    starknetSigners,
    warpRouteConfig,
    multiProvider,
  );

  return starknetDeployer.deployToken();
}

async function getWarpCoreConfigForStarknet(
  warpDeployConfig: WarpRouteDeployConfig,
  multiProvider: MultiProvider,
  contracts: ChainMap<string>,
): Promise<{
  warpCoreConfig: WarpCoreConfig;
  addWarpRouteOptions?: AddWarpRouteOptions;
}> {
  return getWarpCoreConfigCore(
    warpDeployConfig,
    multiProvider,
    contracts,
    generateTokenConfigsForStarknet,
  );
}

function generateTokenConfigsForStarknet(
  warpCoreConfig: WarpCoreConfig,
  warpDeployConfig: WarpRouteDeployConfig,
  contracts: ChainMap<string>,
  symbol: string,
  name: string,
  decimals: number,
): void {
  for (const [chainName, contract] of Object.entries(contracts)) {
    const config = warpDeployConfig[chainName];
    const collateralAddressOrDenom = isCollateralTokenConfig(config)
      ? config.token // gets set in the above deriveTokenMetadata()
      : undefined;
    warpCoreConfig.tokens.push({
      chainName,
      standard:
        STARKNET_TOKEN_TYPE_TO_STANDARD[
          config.type as keyof typeof STARKNET_TOKEN_TYPE_TO_STANDARD
        ],
      decimals,
      symbol,
      name,
      addressOrDenom: contract,
      collateralAddressOrDenom,
    });
  }
}

function validateStarknetWarpConfig(warpRouteConfig: WarpRouteDeployConfig) {
  assert(!warpRouteConfig.isNft, 'NFT routes not supported yet!');

  // token type validation for Starknet chains
  for (const [chain, config] of Object.entries(warpRouteConfig)) {
    assert(
      (STARKNET_SUPPORTED_TOKEN_TYPES as readonly TokenType[]).includes(
        config.type,
      ),
      `Token type "${
        config.type
      }" is not supported on Starknet chains (${chain}}). Supported types: ${STARKNET_SUPPORTED_TOKEN_TYPES.join(
        ', ',
      )}`,
    );
  }
}

async function enrollRemoteRoutersOfStarknetOnEvm(
  multiProvider: MultiProvider,
  evmChains: ChainName[],
  evmRouterAddresses: ChainMap<Address>,
  starknetDeployedAddresses: ChainMap<Address>,
  registryAddresses: ChainMap<ChainAddresses>,
): Promise<AnnotatedEV5Transaction[]> {
  const transactions: AnnotatedEV5Transaction[] = [];

  await promiseObjAll(
    objMap(evmRouterAddresses, async (evmChain, evmRouterAddress) => {
      if (!evmChains.includes(evmChain)) return;

      await retryAsync(async () => {
        // Create warp route reader for the EVM chain
        const warpRouteReader = new EvmERC20WarpRouteReader(
          multiProvider,
          evmChain,
        );

        // Get current config from the deployed router
        const mutatedWarpRouteConfig =
          await warpRouteReader.deriveWarpRouteConfig(evmRouterAddress);

        // Filter for only Starknet chains
        const starknetChains = Object.keys(starknetDeployedAddresses).filter(
          (chain) =>
            multiProvider.getChainMetadata(chain).protocol ===
            ProtocolType.Starknet,
        );

        // Add Starknet routers to the config
        mutatedWarpRouteConfig.remoteRouters =
          starknetChains.reduce<RemoteRouters>(
            (remoteRouters, starknetChain) => {
              remoteRouters[multiProvider.getDomainId(starknetChain)] = {
                address: starknetDeployedAddresses[starknetChain],
              };
              return remoteRouters;
            },
            {},
          );

        const {
          domainRoutingIsmFactory,
          staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory,
          staticAggregationIsmFactory,
          staticAggregationHookFactory,
          staticMerkleRootWeightedMultisigIsmFactory,
          staticMessageIdWeightedMultisigIsmFactory,
        } = registryAddresses[evmChain];

        // Create warp module to update the router
        const evmERC20WarpModule = new EvmERC20WarpModule(multiProvider, {
          config: mutatedWarpRouteConfig,
          chain: evmChain,
          addresses: {
            deployedTokenRoute: evmRouterAddress,
            domainRoutingIsmFactory,
            staticMerkleRootMultisigIsmFactory,
            staticMessageIdMultisigIsmFactory,
            staticAggregationIsmFactory,
            staticAggregationHookFactory,
            staticMerkleRootWeightedMultisigIsmFactory,
            staticMessageIdWeightedMultisigIsmFactory,
          },
        });

        // Generate transactions to update the router
        const chainTxs = await evmERC20WarpModule.update(
          mutatedWarpRouteConfig,
        );
        if (chainTxs.length > 0) {
          transactions.push(...chainTxs);
        }
      });
    }),
  );

  return transactions;
}

interface EnrollRoutersParams {
  evmAddresses: ChainMap<Address>;
  starknetAddresses: ChainMap<Address>;
  context: WriteCommandContext;
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired;
  deployments: WarpCoreConfig;
  multiProvider: MultiProvider;
  starknetSigners: ChainMap<StarknetAccount>;
}

async function enrollCrossChainRouters({
  evmAddresses,
  starknetAddresses,
  context,
  warpRouteConfig,
  deployments,
  multiProvider,
  starknetSigners,
}: EnrollRoutersParams): Promise<void> {
  const hasEvmChains = Object.keys(evmAddresses).length > 0;
  const hasStarknetChains = Object.keys(starknetAddresses).length > 0;

  if (!hasEvmChains || !hasStarknetChains) return;

  logBlue('Enrolling Starknet routers with EVM chains...');

  const registryAddresses = await context.registry.getAddresses();
  const evmChains = Object.keys(evmAddresses);

  const starknetWarpModule = new StarknetERC20WarpModule(
    starknetSigners,
    warpRouteConfig,
    multiProvider,
  );

  await starknetWarpModule.enrollRemoteRouters({
    ...evmAddresses,
    ...starknetAddresses,
  });

  const evmEnrollmentTxs = await enrollRemoteRoutersOfStarknetOnEvm(
    multiProvider,
    evmChains,
    evmAddresses,
    starknetAddresses,
    registryAddresses,
  );

  if (evmEnrollmentTxs.length === 0) return;

  const chainTransactions = groupBy(evmEnrollmentTxs, 'chainId');
  await submitWarpApplyTransactions(
    {
      context,
      warpDeployConfig: warpRouteConfig,
      warpCoreConfig: deployments,
      receiptsDir: './generated/transactions',
    },
    chainTransactions,
  );
}
