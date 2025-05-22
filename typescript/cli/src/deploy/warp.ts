import { confirm } from '@inquirer/prompts';
import { BigNumber } from 'ethers';
import { groupBy } from 'lodash-es';
import { Account as StarknetAccount } from 'starknet';
import { stringify as yamlStringify } from 'yaml';

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
  EvmERC20WarpModule,
  EvmERC20WarpRouteReader,
  ExplorerLicenseType,
  HypERC20Deployer,
  HypERC20Factories,
  HypERC721Factories,
  HyperlaneContracts,
  HyperlaneContractsMap,
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
  StarknetERC20WarpUpdateModule,
  SubmissionStrategy,
  TOKEN_TYPE_TO_STANDARD,
  TokenFactories,
  TokenType,
  TrustedRelayerIsmConfig,
  TxSubmitterBuilder,
  TxSubmitterType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
  attachContractsMap,
  connectContractsMap,
  executeWarpDeploy,
  expandWarpDeployConfig,
  extractIsmAndHookFactoryAddresses,
  getRouterAddressesFromWarpCoreConfig,
  getTokenConnectionId,
  hypERC20factories,
  isCollateralTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
  splitWarpCoreAndExtendedConfigs,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  objKeys,
  objMap,
  promiseObjAll,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { requestAndSaveApiKeys } from '../context/context.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray, logGreen, logTable } from '../logger.js';
import { getSubmitterBuilder } from '../submit/submit.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  prepareStarknetDeploy,
  runPreflightChecksForChains,
} from './utils.js';

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
  warpDeployConfig,
}: {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}) {
  const { skipConfirmation, chainMetadata, registry } = context;
  const multiProtocolSigner = context.multiProtocolSigner;
  const multiProvider = await multiProtocolSigner?.getMultiProvider();
  assert(multiProvider, 'No MultiProvider found!');

  const chains = Object.keys(warpDeployConfig);

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(chains, chainMetadata, registry);

  const deploymentParams = {
    context,
    warpDeployConfig,
  };

  await runDeployPlanStep(deploymentParams);

  const chainsByProtocol = groupChainsByProtocol(chains, context.multiProvider);
  const deployments: WarpCoreConfig = { tokens: [] };
  let deploymentAddWarpRouteOptions: AddWarpRouteOptions | undefined;

  const deployedContracts: {
    evm: ChainMap<Address>;
    starknet: ChainMap<Address>;
  } = {
    evm: {},
    starknet: {},
  };

  let starknetSigners: ChainMap<StarknetAccount> = {};

  // Collect all initial balances across protocols
  let allInitialBalances: Record<string, BigNumber> = {};

  // Execute deployments for each protocol
  for (const protocol of Object.keys(chainsByProtocol) as ProtocolType[]) {
    const protocolChains = chainsByProtocol[protocol];

    // Filter warpDeployConfig to only include chains for this protocol
    const protocolSpecificConfig = Object.fromEntries(
      protocolChains.map((chain) => [chain, warpDeployConfig[chain]]),
    ) as WarpRouteDeployConfigMailboxRequired;

    switch (protocol) {
      case ProtocolType.Ethereum:
        {
          await runPreflightChecksForChains({
            context,
            chains: protocolChains,
            minGas: MINIMUM_WARP_DEPLOY_GAS,
          });
          const initialBalances = await prepareDeploy(
            context,
            null,
            protocolChains,
          );
          allInitialBalances = { ...allInitialBalances, ...initialBalances };

          const deployedEvmContracts = (await executeDeploy(
            { context, warpDeployConfig: protocolSpecificConfig },
            apiKeys,
          )) as any;

          // Store EVM router addresses
          // used in enrollCrossChainRouters
          deployedContracts.evm = objMap(
            deployedEvmContracts as HyperlaneContractsMap<HypERC20Factories>,
            (_, contracts) => getRouter(contracts).address,
          );

          const { warpCoreConfig, addWarpRouteOptions } =
            await getWarpCoreConfig(
              { context, warpDeployConfig: protocolSpecificConfig },
              deployedEvmContracts,
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
        }
        break;

      case ProtocolType.Starknet: {
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

        const initialBalances = await prepareStarknetDeploy(
          context,
          null,
          protocolChains,
        );
        allInitialBalances = { ...allInitialBalances, ...initialBalances };

        deployedContracts.starknet = await executeStarknetDeployments({
          starknetSigners,
          warpRouteConfig: warpDeployConfig,
          multiProvider,
        });
        const { warpCoreConfig, addWarpRouteOptions } =
          await getWarpCoreConfigForStarknet(
            warpDeployConfig,
            multiProvider,
            deployedContracts.starknet,
          );
        deploymentAddWarpRouteOptions = addWarpRouteOptions;
        deployments.tokens = [...deployments.tokens, ...warpCoreConfig.tokens];
        break;
      }

      default:
        throw new Error(`Unsupported protocol type: ${protocol}`);
    }
  }

  logGreen('✅ Warp contract deployments complete');

  await enrollCrossChainRouters({
    evmAddresses: deployedContracts.evm,
    starknetAddresses: deployedContracts.starknet,
    context,
    warpRouteConfig: warpDeployConfig,
    deployments,
    multiProvider,
    starknetSigners,
  });

  // can't be handled in getWarpCoreConfig
  // because its not compatible with starknet
  fullyConnectTokens(deployments, multiProvider);

  await writeDeploymentArtifacts(
    deployments,
    context,
    deploymentAddWarpRouteOptions,
  );

  // Compatible only with EVM and Starknet chains
  await completeDeploy(context, 'warp', allInitialBalances, null, chains);
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
    context: { multiProvider, isDryRun, dryRunChain, registry },
  } = params;

  const config: WarpRouteDeployConfigMailboxRequired =
    isDryRun && dryRunChain
      ? { [dryRunChain]: warpDeployConfig[dryRunChain] }
      : warpDeployConfig;
  const registryAddresses = await registry.getAddresses();

  const deployedContracts = await executeWarpDeploy(
    multiProvider,
    config,
    registryAddresses,
    apiKeys,
  );

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

async function getWarpCoreConfig(
  params: DeployParams,
  contracts: HyperlaneContractsMap<TokenFactories>,
): Promise<{
  warpCoreConfig: WarpCoreConfig;
  addWarpRouteOptions?: AddWarpRouteOptions;
}> {
  const warpCoreConfig: WarpCoreConfig = { tokens: [] };

  // TODO: replace with warp read
  const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    params.context.multiProvider,
    params.warpDeployConfig,
  );
  assert(
    tokenMetadata && isTokenMetadata(tokenMetadata),
    'Missing required token metadata',
  );
  const { decimals, symbol, name } = tokenMetadata;
  assert(decimals, 'Missing decimals on token metadata');

  generateTokenConfigs(
    warpCoreConfig,
    params.warpDeployConfig,
    contracts,
    symbol,
    name,
    decimals,
  );

  fullyConnectTokens(warpCoreConfig, params.context.multiProvider);

  return { warpCoreConfig, addWarpRouteOptions: { symbol } };
}

/**
 * Creates token configs.
 */
function generateTokenConfigs(
  warpCoreConfig: WarpCoreConfig,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
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

  // Extend the warp route and get the updated configs
  const updatedWarpCoreConfig = await extendWarpRoute(
    params,
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
  extendedChains: ChainName[],
) {
  const { context } = params;
  const { multiProvider, multiProtocolSigner } = context;
  // Deploy new contracts with derived metadata
  const extendedConfigs = await deriveMetadataFromExisting(
    multiProvider,
    existingConfigs,
    initialExtendedConfigs,
  );

  const chainsByProtocol = groupChainsByProtocol(extendedChains, multiProvider);
  let newDeployedContracts: ChainMap<Address> = {};
  let starknetSigners: ChainMap<StarknetAccount> = {};

  // Execute deployments for each protocol
  for (const protocol of Object.keys(chainsByProtocol) as ProtocolType[]) {
    const protocolChains = chainsByProtocol[protocol];

    switch (protocol) {
      case ProtocolType.Ethereum:
        {
          const deployedEvmContracts = (await executeDeploy(
            { context, warpDeployConfig: extendedConfigs },
            apiKeys,
          )) as any;

          newDeployedContracts = {
            ...newDeployedContracts,
            ...deployedEvmContracts,
          };
        }
        break;

      case ProtocolType.Starknet: {
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

        const starknetDeployedContracts = await executeStarknetDeployments({
          starknetSigners,
          warpRouteConfig: extendedConfigs, // Only pass protocol-specific config
          multiProvider,
        });
        newDeployedContracts = {
          ...newDeployedContracts,
          ...starknetDeployedContracts,
        };

        break;
      }

      default:
        throw new Error(`Unsupported protocol type: ${protocol}`);
    }
  }
  // Moved router merging and config generation outside the loop
  // Merge existing and new routers
  const mergedRouters = mergeAllRouters(
    params.context.multiProvider,
    existingConfigs,
    newDeployedContracts as any,
    warpCoreConfigByChain,
  );

  // Get the updated core config
  const { warpCoreConfig: updatedWarpCoreConfig, addWarpRouteOptions } =
    await getWarpCoreConfig(params, mergedRouters);
  WarpCoreConfigSchema.parse(updatedWarpCoreConfig);

  // Moved return statement outside the loop
  return {
    newDeployedContracts,
    updatedWarpCoreConfig,
    addWarpRouteOptions,
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
  const warpCoreConfigByChain = Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [token.chainName, token]),
  );
  const warpCoreChains = Object.keys(warpCoreConfigByChain);

  // Split between the existing and additional config
  const [existingConfigs, initialExtendedConfigs] =
    splitWarpCoreAndExtendedConfigs(warpDeployConfig, warpCoreChains);

  const extendedChains = Object.keys(initialExtendedConfigs);
  if (extendedChains.length === 0) {
    return warpCoreConfig;
  }

  logBlue(`Extending Warp Route to ${extendedChains.join(', ')}`);

  // Deploy new contracts with derived metadata and merge with existing config
  const { updatedWarpCoreConfig, addWarpRouteOptions } =
    await deployWarpExtensionContracts(
      params,
      apiKeys,
      existingConfigs,
      initialExtendedConfigs,
      warpCoreConfigByChain,
      extendedChains,
    );

  // Write the updated artifacts
  await writeDeploymentArtifacts(
    updatedWarpCoreConfig,
    context,
    addWarpRouteOptions,
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
  const {
    multiProvider,
    registry,
    multiProtocolSigner,
    multiProtocolProvider,
  } = params.context;
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
      const protocol = multiProvider.getProtocol(chain);
      if (
        protocol !== ProtocolType.Ethereum &&
        protocol !== ProtocolType.Starknet
      ) {
        logBlue(`Skipping non-EVM/Starknet chain ${chain}`);
        return;
      }

      await retryAsync(async () => {
        const deployedTokenRoute = deployedRoutersAddresses[chain];
        assert(deployedTokenRoute, `Missing artifacts for ${chain}.`);
        const configWithMailbox = {
          ...config,
          mailbox: registryAddresses[chain].mailbox,
        };

        if (protocol === ProtocolType.Ethereum) {
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
        } else if (protocol === ProtocolType.Starknet) {
          assert(
            multiProtocolSigner,
            'multi protocol signer is required for starknet chain deployment',
          );

          const starknetSigner = multiProtocolSigner.getStarknetSigner(chain);
          const starknetERC20WarpModule = new StarknetERC20WarpUpdateModule(
            starknetSigner,
            multiProtocolProvider,
            expandedWarpDeployConfig,
            chain,
            {
              config: configWithMailbox,
              chain,
              addresses: {
                deployedTokenRoute,
                ...extractIsmAndHookFactoryAddresses(registryAddresses[chain]), // should be address zero
              },
            },
          );
          transactions.push(
            ...(await starknetERC20WarpModule.update(configWithMailbox)),
          );
        }
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
  existingConfigs: WarpRouteDeployConfigMailboxRequired,
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

/**
 * Starknet
 */

function groupChainsByProtocol(
  chains: ChainName[],
  multiProvider: MultiProvider,
): Record<ProtocolType, ChainName[]> {
  return chains.reduce(
    (protocolMap, chainName) => {
      const protocolType = multiProvider.tryGetProtocol(chainName);
      assert(protocolType, `Protocol not found for chain: ${chainName}`);

      if (!protocolMap[protocolType]) {
        protocolMap[protocolType] = [];
      }

      protocolMap[protocolType].push(chainName);
      return protocolMap;
    },
    {} as Record<ProtocolType, ChainName[]>,
  );
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
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
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
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
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

function validateStarknetWarpConfig(
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired,
) {
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

async function getWarpCoreConfigCore<T>(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  contracts: T,
  generateConfigsFn: (
    warpCoreConfig: WarpCoreConfig,
    warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
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

async function enrollStarknetRoutersOnEvmChains(
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
        starknetChains.reduce<RemoteRouters>((remoteRouters, starknetChain) => {
          remoteRouters[multiProvider.getDomainId(starknetChain)] = {
            address: starknetDeployedAddresses[starknetChain],
          };
          return remoteRouters;
        }, {});

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
      const chainTxs = await evmERC20WarpModule.update(mutatedWarpRouteConfig);
      if (chainTxs.length > 0) {
        transactions.push(...chainTxs);
      }
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
  const evmEnrollmentTxs = await enrollStarknetRoutersOnEvmChains(
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

//TODO: add return type
export function getRouter(
  contracts: HyperlaneContracts<HypERC20Factories>,
): any {
  for (const key of objKeys(hypERC20factories)) {
    if (contracts[key]) return contracts[key];
  }
  throw new Error('No matching contract found.');
}
