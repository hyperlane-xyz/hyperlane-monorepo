import { confirm } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { AltVMWarpModule } from '@hyperlane-xyz/deploy-sdk';
import {
  AltVMJsonRpcTxSubmitter,
  GasAction,
  ProtocolType,
} from '@hyperlane-xyz/provider-sdk';
import {
  AddWarpRouteConfigOptions,
  BaseRegistry,
  ChainAddresses,
} from '@hyperlane-xyz/registry';
import {
  AggregationIsmConfig,
  CCIPContractCache,
  ChainMap,
  ChainName,
  ContractVerifier,
  EvmERC20WarpModule,
  ExplorerLicenseType,
  HypERC20Deployer,
  IsmType,
  MultiProvider,
  MultisigIsmConfig,
  OpStackIsmConfig,
  PausableIsmConfig,
  RoutingIsmConfig,
  SubmissionStrategy,
  TokenMetadataMap,
  TrustedRelayerIsmConfig,
  TxSubmitterBuilder,
  TxSubmitterType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
  altVmChainLookup,
  enrollCrossChainRouters,
  executeWarpDeploy,
  expandWarpDeployConfig,
  extractIsmAndHookFactoryAddresses,
  getRouterAddressesFromWarpCoreConfig,
  getSubmitterBuilder,
  getTokenConnectionId,
  isCollateralTokenConfig,
  isXERC20TokenConfig,
  splitWarpCoreAndExtendedConfigs,
  tokenTypeToStandard,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  mustGet,
  objFilter,
  objMap,
  promiseObjAll,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { TypedAnnotatedTransaction } from '../../../sdk/dist/providers/ProviderType.js';
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
import { AltVMFileSubmitter } from '../submitters/AltVMFileSubmitter.js';
import { EV5FileSubmitter } from '../submitters/EV5FileSubmitter.js';
import {
  CustomTxSubmitterType,
  ExtendedChainSubmissionStrategy,
  ExtendedChainSubmissionStrategySchema,
  ExtendedSubmissionStrategy,
} from '../submitters/types.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';
import { canSelfRelay, runSelfRelay } from '../utils/relay.js';

import { validateWarpConfigForAltVM } from './configValidation.js';
import {
  completeDeploy,
  getBalances,
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
  const {
    skipConfirmation,
    chainMetadata,
    registry,
    multiProvider,
    altVmSigners,
  } = context;

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

  // Some of the below functions throw if passed non-EVM or non-supported chains
  const deploymentChains = chains.filter(
    (chain) =>
      chainMetadata[chain].protocol === ProtocolType.Ethereum ||
      !!altVmSigners[chain],
  );

  await runPreflightChecksForChains({
    context,
    chains: deploymentChains,
    minGas: GasAction.WARP_DEPLOY_GAS,
  });

  const initialBalances = await getBalances(context, deploymentChains);

  const { deployedContracts } = await executeDeploy(deploymentParams, apiKeys);

  const registryAddresses = await registry.getAddresses();

  const enrollTxs = await enrollCrossChainRouters(
    { multiProvider, altVmSigners, registryAddresses, warpDeployConfig },
    deployedContracts,
  );

  for (const chain of Object.keys(enrollTxs)) {
    log(`Enrolling routers for chain ${chain}`);
    const { submitter } = await getSubmitterByStrategy({
      chain,
      context: context,
    });
    await submitter.submit(...(enrollTxs[chain] as any[]));
  }

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

  if (skipConfirmation) return;

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
    context: { multiProvider, altVmSigners, registry },
  } = params;

  const registryAddresses = await registry.getAddresses();

  const deployedContracts = await executeWarpDeploy(
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    apiKeys,
  );

  const { warpCoreConfig: deployments } = await getWarpCoreConfig(
    { context: params.context, warpDeployConfig },
    deployedContracts,
  );

  logGreen('✅ Warp contract deployments complete');
  return { deployedContracts, deployments };
}

async function writeDeploymentArtifacts(
  warpCoreConfig: WarpCoreConfig,
  context: WriteCommandContext,
  addWarpRouteOptions?: AddWarpRouteConfigOptions,
) {
  log('Writing deployment artifacts...');
  await context.registry.addWarpRoute(warpCoreConfig, addWarpRouteOptions);

  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
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
  const { chainMetadata, skipConfirmation, multiProvider } = context;

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

  // temporarily configure deployer as owner so that warp update after extension
  // can leverage JSON RPC submitter on new chains
  const intermediateOwnerConfig = await promiseObjAll(
    objMap(params.warpDeployConfig, async (chain, config) => {
      const protocolType = multiProvider.getProtocol(chain);
      if (protocolType === ProtocolType.Ethereum) {
        return {
          ...config,
          owner: await context.multiProvider.getSignerAddress(chain),
        };
      } else if (context.altVmSigners[chain]) {
        const signer = mustGet(context.altVmSigners, chain);
        return {
          ...config,
          owner: signer.getSignerAddress(),
        };
      } else {
        return config;
      }
    }),
  );

  // Extend the warp route and get the updated configs
  const updatedWarpCoreConfig = await extendWarpRoute(
    { ...params, warpDeployConfig: intermediateOwnerConfig },
    apiKeys,
    warpCoreConfig,
  );

  // Then create and submit update transactions
  const updateTransactions = await updateExistingWarpRoute(
    params,
    apiKeys,
    warpDeployConfig,
    updatedWarpCoreConfig,
  );

  // Check if update transactions are empty
  const hasAnyTx = Object.values(updateTransactions).some(
    (txs) => txs.length > 0,
  );

  if (!hasAnyTx)
    return logGreen(`Warp config is the same as target. No updates needed.`);

  await submitWarpApplyTransactions(params, updateTransactions);
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
  const { existingConfigs, initialExtendedConfigs, warpCoreConfigByChain } =
    getWarpRouteExtensionDetails(warpCoreConfig, warpDeployConfig);

  // Remove all the non compatible chains from the extended configuration to avoid
  // having the extension crash
  const filteredExtendedConfigs = objFilter(
    initialExtendedConfigs,
    (chainName, _): _ is (typeof initialExtendedConfigs)[string] =>
      context.supportedProtocols.includes(
        context.multiProvider.getProtocol(chainName),
      ),
  );

  const filteredExistingConfigs = objFilter(
    existingConfigs,
    (chainName, _): _ is (typeof existingConfigs)[string] =>
      context.supportedProtocols.includes(
        context.multiProvider.getProtocol(chainName),
      ),
  );

  const filteredWarpCoreConfigByChain = objFilter(
    warpCoreConfigByChain,
    (chainName, _): _ is (typeof warpCoreConfigByChain)[string] =>
      context.supportedProtocols.includes(
        context.multiProvider.getProtocol(chainName),
      ),
  );

  // Get the non compatible chains that should not be unenrolled/removed after the extension
  // otherwise the update will generate unenroll transactions
  const nonCompatibleWarpCoreConfigs: WarpCoreConfig['tokens'] = Object.entries(
    warpCoreConfigByChain,
  )
    .filter(
      ([chainName]) =>
        !context.supportedProtocols.includes(
          context.multiProvider.getProtocol(chainName),
        ) && !!warpDeployConfig[chainName],
    )
    .map(([_, config]) => config);

  const filteredExtendedChains = Object.keys(filteredExtendedConfigs);
  if (filteredExtendedChains.length === 0) {
    return warpCoreConfig;
  }

  logBlue(`Extending Warp Route to ${filteredExtendedChains.join(', ')}`);

  // Deploy new contracts with derived metadata and merge with existing config
  const { updatedWarpCoreConfig, addWarpRouteOptions } =
    await deployWarpExtensionContracts(
      params,
      apiKeys,
      filteredExistingConfigs,
      filteredExtendedConfigs,
      filteredWarpCoreConfigByChain,
    );

  // Re-add the non compatible chains to the warp core config so that expanding the config
  // to get the proper remote routers and gas config works as expected
  updatedWarpCoreConfig.tokens.push(...nonCompatibleWarpCoreConfigs);

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
): Promise<ChainMap<TypedAnnotatedTransaction[]>> {
  logBlue('Updating deployed Warp Routes');
  const { multiProvider, altVmProviders, altVmSigners, registry } =
    params.context;

  const registryAddresses =
    (await registry.getAddresses()) as ChainMap<ChainAddresses>;
  const ccipContractCache = new CCIPContractCache(registryAddresses);
  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  const updateTransactions = {} as ChainMap<TypedAnnotatedTransaction[]>;

  // Get all deployed router addresses
  const deployedRoutersAddresses =
    getRouterAddressesFromWarpCoreConfig(warpCoreConfig);

  const expandedWarpDeployConfig = await expandWarpDeployConfig({
    multiProvider,
    altVmProviders,
    warpDeployConfig,
    deployedRoutersAddresses,
  });

  await promiseObjAll(
    objMap(expandedWarpDeployConfig, async (chain, config) => {
      await retryAsync(async () => {
        const protocolType = multiProvider.getProtocol(chain);
        if (protocolType !== ProtocolType.Ethereum && !altVmSigners[chain]) {
          logBlue(`Skipping non-compatible chain ${chain}`);
          return;
        }

        const deployedTokenRoute = deployedRoutersAddresses[chain];
        assert(deployedTokenRoute, `Missing artifacts for ${chain}.`);
        const configWithMailbox = {
          ...config,
          mailbox: registryAddresses[chain].mailbox,
        };

        switch (protocolType) {
          case ProtocolType.Ethereum: {
            const evmERC20WarpModule = new EvmERC20WarpModule(
              multiProvider,
              {
                config: configWithMailbox,
                chain,
                addresses: {
                  deployedTokenRoute,
                  ...extractIsmAndHookFactoryAddresses(
                    registryAddresses[chain],
                  ),
                },
              },
              ccipContractCache,
              contractVerifier,
            );
            const transactions =
              await evmERC20WarpModule.update(configWithMailbox);
            updateTransactions[chain] = transactions;
            break;
          }
          default: {
            const signer = mustGet(altVmSigners, chain);
            const validatedConfig = validateWarpConfigForAltVM(
              configWithMailbox,
              chain,
            );

            const warpModule = new AltVMWarpModule(
              altVmChainLookup(multiProvider),
              signer,
              {
                config: validatedConfig,
                chain,
                addresses: {
                  deployedTokenRoute,
                },
              },
            );

            const transactions = await warpModule.update(validatedConfig);
            updateTransactions[chain] = transactions;
            break;
          }
        }
      });
    }),
  );
  return updateTransactions;
}

/**
 * Retrieves a chain submission strategy from the provided filepath.
 * @param submissionStrategyFilepath a filepath to the submission strategy file
 * @returns a formatted submission strategy
 */
export function readChainSubmissionStrategy(
  submissionStrategyFilepath: string,
): ExtendedChainSubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return ExtendedChainSubmissionStrategySchema.parse(
    submissionStrategyFileContent,
  );
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
  updateTransactions: ChainMap<TypedAnnotatedTransaction[]>,
): Promise<void> {
  const { extendedChains } = getWarpRouteExtensionDetails(
    params.warpCoreConfig,
    params.warpDeployConfig,
  );

  for (const [chain, transactions] of Object.entries(updateTransactions)) {
    try {
      const protocol = params.context.multiProvider.getProtocol(chain);

      await retryAsync(
        async () => {
          const isExtendedChain = extendedChains.includes(chain);
          const { submitter, config } = await getSubmitterByStrategy({
            chain,
            context: params.context,
            strategyUrl: params.strategyUrl,
            isExtendedChain,
          });
          const transactionReceipts = await submitter.submit(
            ...(transactions as any[]),
          );

          if (protocol !== ProtocolType.Ethereum) {
            return;
          }

          if (transactionReceipts) {
            const receiptPath = `${params.receiptsDir}/${chain}-${
              submitter.txSubmitterType
            }-${Date.now()}-receipts.json`;
            writeYamlOrJson(receiptPath, transactionReceipts);
            logGreen(
              `Transaction receipts for ${protocol} chain ${chain} successfully written to ${receiptPath}`,
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
      rootLogger.debug('Error in submitWarpApplyTransactions', e);
      logBlue(`Error in submitWarpApplyTransactions`, e);
      console.dir(transactions);
    }
  }
}

/**
 * Helper function to get warp apply specific submitter.
 *
 * @returns the warp apply submitter
 */
export async function getSubmitterByStrategy<T extends ProtocolType>({
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
  config: ExtendedSubmissionStrategy;
}> {
  const { multiProvider, altVmSigners, registry } = context;

  const defaultSubmitter: ExtendedSubmissionStrategy = {
    submitter: {
      chain,
      type: TxSubmitterType.JSON_RPC,
    },
  };

  // if the requested chain is not defined in the config, transaction submission will crash
  const submissionStrategy: ExtendedSubmissionStrategy | undefined =
    strategyUrl && !isExtendedChain
      ? readChainSubmissionStrategy(strategyUrl)[chain]
      : defaultSubmitter;

  const strategyToUse = submissionStrategy ?? defaultSubmitter;
  const protocol = multiProvider.getProtocol(chain);

  const additionalSubmitterFactories: any = {
    [ProtocolType.Ethereum]: {
      file: (_multiProvider: MultiProvider, metadata: any) => {
        return new EV5FileSubmitter(metadata);
      },
    },
  };

  // Only add non-Ethereum protocol factories if we have an alt VM signer
  if (protocol !== ProtocolType.Ethereum) {
    const signer = mustGet(altVmSigners, chain);
    additionalSubmitterFactories[protocol] = {
      jsonRpc: () => {
        return new AltVMJsonRpcTxSubmitter(signer, {
          chain: chain,
        });
      },
      [CustomTxSubmitterType.FILE]: (
        _multiProvider: MultiProvider,
        metadata: any,
      ) => {
        return new AltVMFileSubmitter(signer, metadata);
      },
    };
  }

  return {
    submitter: await getSubmitterBuilder<T>({
      submissionStrategy: strategyToUse as SubmissionStrategy, // TODO: fix this
      multiProvider,
      coreAddressesByChain: await registry.getAddresses(),
      additionalSubmitterFactories,
    }),
    config: submissionStrategy,
  };
}
