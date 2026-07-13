import { confirm } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  AltVMJsonRpcSubmitter,
  createWarpTokenWriter,
} from '@hyperlane-xyz/deploy-sdk';
import { AltVMFileSubmitter } from '@hyperlane-xyz/deploy-sdk/AltVMFileSubmitter';
import { GasAction, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { warpConfigToArtifact } from '@hyperlane-xyz/provider-sdk/warp';
import {
  type AddWarpRouteConfigOptions,
  type ChainAddresses,
} from '@hyperlane-xyz/registry';
import {
  type AggregationIsmConfig,
  CCIPContractCache,
  type ChainMap,
  type ChainName,
  type CompositeIsmConfig,
  type CompositeIsmNodeConfig,
  ContractVerifier,
  EvmWarpModule,
  ExplorerLicenseType,
  HypERC20Deployer,
  IsmType,
  type MultiProvider,
  type MultisigIsmConfig,
  type OpStackIsmConfig,
  type PausableIsmConfig,
  type HypTokenRouterConfig,
  type ProtocolTransaction,
  type RoutingIsmConfig,
  type SubmissionStrategy,
  type TokenMetadataMap,
  type TrustedRelayerIsmConfig,
  type TxSubmitterBuilder,
  TxSubmitterType,
  type TypedAnnotatedTransaction,
  type WarpCoreConfig,
  WarpCoreConfigSchema,
  type WarpRouteDeployConfig,
  type WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
  TOKEN_CROSS_COLLATERAL_STANDARDS,
  altVmChainLookup,
  enrollCrossChainRouters,
  executeWarpDeploy,
  expandWarpDeployConfig,
  extractIsmAndHookFactoryAddresses,
  getRouterAddressesFromWarpCoreConfig,
  getSubmitterBuilder,
  getTokenConnectionId,
  isCrossCollateralTokenConfig,
  normalizeScale,
  splitWarpCoreAndExtendedConfigs,
  tokenTypeToStandard,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  type Annotated,
  addressToBytes32,
  assert,
  formatError,
  isEVMLike,
  isNullish,
  mapAllSettled,
  mustGet,
  objFilter,
  objMap,
  promiseObjAll,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/apiKeys.js';
import { type WriteCommandContext } from '../context/types.js';
import {
  errorRed,
  log,
  logBlue,
  logGray,
  logGreen,
  logTable,
  warnYellow,
} from '../logger.js';
import { WarpSendLogs } from '../send/transfer.js';
import { EV5FileSubmitter } from '../submitters/EV5FileSubmitter.js';
import {
  CustomTxSubmitterType,
  type ExtendedChainSubmissionStrategy,
  ExtendedChainSubmissionStrategySchema,
  type ExtendedSubmissionStrategy,
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
}: {
  context: WriteCommandContext;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpRouteId?: string;
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
      isEVMLike(chainMetadata[chain].protocol) || !!altVmSigners[chain],
  );

  await runPreflightChecksForChains({
    context,
    chains: deploymentChains,
    minGas: GasAction.WARP_DEPLOY_GAS,
  });

  const initialBalances = await getBalances(context, deploymentChains);

  logBlue('🚀 All systems ready, captain! Beginning deployment...');
  const { deployedContracts } = await executeDeploy(deploymentParams, apiKeys);

  const registryAddresses = await registry.getAddresses();

  const enrollTxs = await enrollCrossChainRouters(
    { multiProvider, altVmSigners, registryAddresses, warpDeployConfig },
    deployedContracts,
  );

  // Group chains by protocol type for appropriate parallelization
  // EVM chains can run in parallel (each chain has an independent nonce)
  // Non-EVM chains (e.g., Cosmos) must run sequentially because when the same
  // private key is used across multiple chains, parallel tx submission causes
  // sequence number conflicts (both txs query sequence N, one succeeds with N,
  // the other fails expecting N+1)
  const enrollChains = Object.keys(enrollTxs);
  const evmChains = enrollChains.filter((chain) =>
    isEVMLike(multiProvider.getProtocol(chain)),
  );
  const nonEvmChains = enrollChains.filter(
    (chain) => !isEVMLike(multiProvider.getProtocol(chain)),
  );

  const enrollFailures: string[] = [];

  // Helper function to submit enrollment for a single chain
  const submitEnrollment = async (chain: string): Promise<void> => {
    log(`Enrolling routers for chain ${chain}`);
    const { submitter } = await getSubmitterByStrategy({
      chain,
      context: context,
    });
    await submitter.submit(...(enrollTxs[chain] as any[]));
  };

  // Submit EVM chains in parallel (they have independent signers)
  if (evmChains.length > 0) {
    const { rejected } = await mapAllSettled(
      evmChains,
      (chain) => submitEnrollment(chain),
      (chain) => chain,
    );

    for (const [chain, error] of rejected) {
      errorRed(`Failed to enroll routers for chain ${chain}: ${error.message}`);
      enrollFailures.push(chain);
    }
  }

  // Submit non-EVM chains sequentially (they may share signers)
  for (const chain of nonEvmChains) {
    try {
      await submitEnrollment(chain);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errorRed(`Failed to enroll routers for chain ${chain}: ${errorMessage}`);
      enrollFailures.push(chain);
    }
  }

  if (enrollFailures.length > 0) {
    throw new Error(
      `Router enrollment failed for chain(s): ${enrollFailures.join(', ')}`,
    );
  }

  const { warpCoreConfig, addWarpRouteOptions } = await getWarpCoreConfig(
    deploymentParams,
    deployedContracts,
  );

  // Use warpRouteId if provided, otherwise if the user is deploying
  // use addWarpRouteOptions derived from warp core config.
  let warpRouteIdOptions: AddWarpRouteConfigOptions;
  if (warpRouteId) {
    warpRouteIdOptions = { warpRouteId };
  } else {
    warpRouteIdOptions = addWarpRouteOptions;
  }

  await writeDeploymentArtifacts(warpCoreConfig, context, warpRouteIdOptions);
  await context.registry.addWarpRouteConfig(
    warpDeployConfig,
    warpRouteIdOptions,
  );

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

  // Filter deploy config to only chains with deployed contracts.
  // During partial failures, some chains may have broken RPCs — deriveTokenMetadata
  // would fail trying to call erc20.name()/symbol() on unreachable chains.
  const deployedChains = Object.keys(contracts);
  const deployedWarpConfig = objFilter(
    params.warpDeployConfig,
    (chain, _): _ is (typeof params.warpDeployConfig)[string] =>
      deployedChains.includes(chain),
  );

  // TODO: replace with warp read
  const tokenMetadataMap: TokenMetadataMap =
    await HypERC20Deployer.deriveTokenMetadata(
      params.context.multiProvider,
      deployedWarpConfig,
    );

  generateTokenConfigs(
    params.context.multiProvider,
    warpCoreConfig,
    deployedWarpConfig,
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
      'token' in config && typeof config.token === 'string'
        ? config.token
        : undefined;

    const protocol = multiProvider.getProtocol(chainName);

    if (protocol === ProtocolType.Unknown) {
      continue;
    }

    warpCoreConfig.tokens.push({
      chainName,
      standard: tokenTypeToStandard(protocol as ProtocolType, config.type),
      tokenType: config.type,
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
      if (isEVMLike(protocolType)) {
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
  const {
    txs: updateTransactions,
    feeTxs: feeUpdateTransactions,
    ownershipTxs: ownershipTransactions,
  } = await updateExistingWarpRoute(
    params,
    apiKeys,
    warpDeployConfig,
    updatedWarpCoreConfig,
  );

  // Check if update transactions are empty
  const hasAnyTx = [
    ...Object.values(updateTransactions),
    ...Object.values(feeUpdateTransactions),
    ...Object.values(ownershipTransactions),
  ].some((txs) => txs.length > 0);

  if (!hasAnyTx)
    return logGreen(`Warp config is the same as target. No updates needed.`);

  await submitWarpApplyTransactions(
    params,
    updateTransactions,
    feeUpdateTransactions,
    ownershipTransactions,
  );
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

  // Derive metadata once for all new chains
  const extendedConfigs = await deriveMetadataFromExisting(
    context.multiProvider,
    filteredExistingConfigs,
    filteredExtendedConfigs,
  );

  // Helper to deploy a single extension chain
  const deployExtension = async (chain: string): Promise<ChainMap<Address>> => {
    logBlue(`Deploying extension to ${chain}...`);
    const { deployedContracts } = await executeDeploy(
      {
        context: params.context,
        warpDeployConfig: { [chain]: extendedConfigs[chain] },
      },
      apiKeys,
    );
    logGreen(`Successfully deployed extension to ${chain}`);
    return deployedContracts;
  };

  // Group chains by protocol type for appropriate parallelization
  // EVM chains can run in parallel (each chain has an independent nonce)
  // Non-EVM chains must run sequentially because when the same private key
  // is used across multiple chains, parallel tx submission causes sequence
  // number conflicts
  const evmExtendChains = filteredExtendedChains.filter((chain) =>
    isEVMLike(context.multiProvider.getProtocol(chain)),
  );
  const nonEvmExtendChains = filteredExtendedChains.filter(
    (chain) => !isEVMLike(context.multiProvider.getProtocol(chain)),
  );

  let newDeployedContracts: ChainMap<Address> = {};
  const allRejected = new Map<string, Error>();

  // Deploy EVM chains in parallel
  if (evmExtendChains.length > 0) {
    const { fulfilled, rejected } = await mapAllSettled(
      evmExtendChains,
      (chain) => deployExtension(chain),
      (chain) => chain,
    );

    for (const [, contracts] of fulfilled) {
      newDeployedContracts = { ...newDeployedContracts, ...contracts };
    }
    for (const [chain, error] of rejected) {
      errorRed(`Failed to deploy extension to ${chain}: ${formatError(error)}`);
      allRejected.set(chain, error);
    }
  }

  // Deploy non-EVM chains sequentially (shared signers)
  for (const chain of nonEvmExtendChains) {
    try {
      const contracts = await deployExtension(chain);
      newDeployedContracts = { ...newDeployedContracts, ...contracts };
    } catch (error: unknown) {
      errorRed(`Failed to deploy extension to ${chain}: ${formatError(error)}`);
      allRejected.set(
        chain,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  if (Object.keys(newDeployedContracts).length === 0 && allRejected.size > 0) {
    throw new Error(
      `Extension deployment failed for all chains: ${[...allRejected.keys()].join(', ')}. Re-run to retry.`,
    );
  }

  const mergedRouters = mergeAllRouters(
    filteredExistingConfigs,
    newDeployedContracts,
    filteredWarpCoreConfigByChain,
  );

  const { warpCoreConfig: updatedWarpCoreConfig, addWarpRouteOptions } =
    await getWarpCoreConfig(params, mergedRouters);
  WarpCoreConfigSchema.parse(updatedWarpCoreConfig);

  // Re-add the non compatible chains to the warp core config so that expanding the config
  // to get the proper remote routers and gas config works as expected
  updatedWarpCoreConfig.tokens.push(...nonCompatibleWarpCoreConfigs);

  // Preserve metadata fields from existing config that generateTokenConfigs doesn't include
  // (e.g. logoURI, coinGeckoId, igpTokenAddressOrDenom, scale).
  // Spread order ensures generated fields (address, decimals, connections) take precedence.
  updatedWarpCoreConfig.tokens = updatedWarpCoreConfig.tokens.map((token) => {
    const existingToken = warpCoreConfigByChain[token.chainName];
    return existingToken ? { ...existingToken, ...token } : token;
  });

  // Preserve top-level options if no updates
  if (warpCoreConfig.options) {
    updatedWarpCoreConfig.options = {
      ...warpCoreConfig.options,
      ...updatedWarpCoreConfig.options,
    };
  }

  const warpRouteOptions = params.warpRouteId
    ? { warpRouteId: params.warpRouteId }
    : addWarpRouteOptions;

  // Write the updated artifacts
  await writeDeploymentArtifacts(
    updatedWarpCoreConfig,
    context,
    warpRouteOptions,
  );
  await context.registry.addWarpRouteConfig(warpDeployConfig, warpRouteOptions);

  // Throw after persisting successes so user can re-run for failures
  if (allRejected.size > 0) {
    throw new Error(
      `Extension deployment failed for chain(s): ${[...allRejected.keys()].join(', ')}. ` +
        `Successfully deployed chains have been saved to registry. Re-run to retry failed chains.`,
    );
  }

  return updatedWarpCoreConfig;
}

type WarpApplyTransactions = {
  txs: ChainMap<TypedAnnotatedTransaction[]>;
  feeTxs: ChainMap<TypedAnnotatedTransaction[]>;
  ownershipTxs: ChainMap<TypedAnnotatedTransaction[]>;
};

type SafeTxBuilderPayload = {
  version: string;
  chainId: string;
  meta: Record<string, unknown>;
  transactions: object[];
};

function isSafeTxBuilderPayload(value: unknown): value is SafeTxBuilderPayload {
  return (
    value != null &&
    typeof value === 'object' &&
    'chainId' in value &&
    'transactions' in value &&
    Array.isArray((value as SafeTxBuilderPayload).transactions)
  );
}

// Updates Warp routes with new configurations.
async function updateExistingWarpRoute(
  params: WarpApplyParams,
  apiKeys: ChainMap<string>,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  warpCoreConfig: WarpCoreConfig,
): Promise<WarpApplyTransactions> {
  logBlue('Updating deployed Warp Routes');
  const { multiProvider, altVmSigners, registry } = params.context;

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
  const feeUpdateTransactions = {} as ChainMap<TypedAnnotatedTransaction[]>;
  const ownershipTransactions = {} as ChainMap<TypedAnnotatedTransaction[]>;

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
      await retryAsync(async () => {
        const protocolType = multiProvider.getProtocol(chain);
        if (!isEVMLike(protocolType) && !altVmSigners[chain]) {
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
          case ProtocolType.Tron:
          case ProtocolType.Ethereum: {
            const evmERC20WarpModule = new EvmWarpModule(
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
            const { txs, feeTxs, ownershipTxs } =
              await evmERC20WarpModule.updateSplit(configWithMailbox);
            updateTransactions[chain] = txs;
            feeUpdateTransactions[chain] = feeTxs;
            ownershipTransactions[chain] = ownershipTxs;
            break;
          }
          default: {
            const signer = mustGet(altVmSigners, chain);
            const validatedConfig = validateWarpConfigForAltVM(
              configWithMailbox,
              chain,
              protocolType,
            );

            const chainLookup = altVmChainLookup(multiProvider);
            const chainMetadata = chainLookup.getChainMetadata(chain);
            const writer = createWarpTokenWriter(
              chainMetadata,
              chainLookup,
              signer,
            );
            const artifact = warpConfigToArtifact(validatedConfig, chainLookup);
            const artifactToUpdate = {
              artifactState: ArtifactState.DEPLOYED,
              config: artifact.config,
              deployed: { address: deployedTokenRoute },
            };

            const transactions = await writer.update(artifactToUpdate);
            updateTransactions[chain] = transactions;
            break;
          }
        }
      });
    }),
  );
  return {
    txs: updateTransactions,
    feeTxs: feeUpdateTransactions,
    ownershipTxs: ownershipTransactions,
  };
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
  | TrustedRelayerIsmConfig // type, relayer
  | CompositeIsmConfig; // type, owner, root (Sealevel-only)

export function transformDeployConfigForDisplay(
  deployConfig: WarpRouteDeployConfigMailboxRequired,
) {
  const transformedIsmConfigs: Record<ChainName, Record<string, unknown>[]> =
    {};
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

function transformIsmConfigForDisplay(
  ismConfig: IsmDisplayConfig,
): Record<string, unknown>[] {
  const ismConfigs: Record<string, unknown>[] = [];
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
    case IsmType.COMPOSITE:
      return [
        {
          Type: ismConfig.type,
          Owner: ismConfig.owner,
          Root: 'See table(s) below.',
        },
        ...transformCompositeIsmNodeForDisplay(ismConfig.root),
      ];
    default:
      return [ismConfig];
  }
}

/**
 * Recursively flattens a composite ISM's node tree into display rows, one row
 * per node — mirrors how AGGREGATION recurses into `modules` above. Nested
 * node configs (subIsms, lower/upper, domains) are never printed as raw
 * objects; each becomes its own row via recursion.
 */
function transformCompositeIsmNodeForDisplay(
  node: CompositeIsmNodeConfig,
): Record<string, unknown>[] {
  switch (node.type) {
    case 'aggregation':
      return [
        {
          Type: node.type,
          Threshold: node.threshold,
          SubIsms: 'See table(s) below.',
        },
        ...node.subIsms.flatMap((sub) =>
          transformCompositeIsmNodeForDisplay(sub),
        ),
      ];
    case 'amountRouting':
      return [
        {
          Type: node.type,
          Threshold: node.threshold,
          Lower: 'See table(s) below.',
          Upper: 'See table(s) below.',
        },
        ...transformCompositeIsmNodeForDisplay(node.lower),
        ...transformCompositeIsmNodeForDisplay(node.upper),
      ];
    case 'routing':
      return [
        {
          Type: node.type,
          Domains: node.domains
            ? Object.keys(node.domains).join(', ')
            : 'Undefined',
        },
        ...(node.domains
          ? Object.values(node.domains).flatMap((sub) =>
              transformCompositeIsmNodeForDisplay(sub),
            )
          : []),
      ];
    case 'fallbackRouting':
      return [
        {
          Type: node.type,
          FallbackIsm: node.fallbackIsm,
          Domains: node.domains
            ? Object.keys(node.domains).join(', ')
            : 'Undefined',
        },
        ...(node.domains
          ? Object.values(node.domains).flatMap((sub) =>
              transformCompositeIsmNodeForDisplay(sub),
            )
          : []),
      ];
    case 'trustedRelayer':
      return [{ Type: node.type, Relayer: node.relayer }];
    case 'multisigMessageId':
      return [
        {
          Type: node.type,
          Validators: node.validators,
          Threshold: node.threshold,
        },
      ];
    case 'test':
      return [{ Type: node.type, Accept: node.accept }];
    case 'pausable':
      return [{ Type: node.type, Paused: node.paused }];
    case 'rateLimited':
      return [
        {
          Type: node.type,
          MaxCapacity: node.maxCapacity,
          Mailbox: node.mailbox,
          Recipient: node.recipient ?? 'Undefined',
        },
      ];
    default: {
      const _exhaustive: never = node;
      return [_exhaustive];
    }
  }
}

async function getFeeSubmitterByStrategy<T extends ProtocolType>({
  chain,
  context,
  strategyUrl,
}: {
  chain: ChainName;
  context: WriteCommandContext;
  strategyUrl?: string;
}): Promise<TxSubmitterBuilder<T> | undefined> {
  const { multiProvider, altVmSigners, registry } = context;

  if (!strategyUrl) return undefined;

  const submissionStrategy = readChainSubmissionStrategy(strategyUrl)[chain];
  if (!submissionStrategy?.feeSubmitter) return undefined;

  const feeStrategy: ExtendedSubmissionStrategy = {
    submitter: submissionStrategy.feeSubmitter,
  };

  const protocol = multiProvider.getProtocol(chain);
  const additionalSubmitterFactories: any = {
    [ProtocolType.Tron]: {
      file: (_multiProvider: MultiProvider, metadata: any) =>
        new EV5FileSubmitter(metadata),
    },
    [ProtocolType.Ethereum]: {
      file: (_multiProvider: MultiProvider, metadata: any) =>
        new EV5FileSubmitter(metadata),
    },
  };

  if (!isEVMLike(protocol)) {
    const signer = mustGet(altVmSigners, chain);
    additionalSubmitterFactories[protocol] = {
      jsonRpc: () => new AltVMJsonRpcSubmitter(signer, { chain }),
      [CustomTxSubmitterType.FILE]: (
        _multiProvider: MultiProvider,
        metadata: any,
      ) => new AltVMFileSubmitter(signer, metadata),
    };
  }

  return getSubmitterBuilder<T>({
    submissionStrategy: feeStrategy as SubmissionStrategy,
    multiProvider,
    coreAddressesByChain: await registry.getAddresses(),
    additionalSubmitterFactories,
  });
}

type ChainTxPayloads = {
  safePayloads: SafeTxBuilderPayload[];
  feeError?: string;
};

// Extracts the Gnosis Safe address from a submitter metadata object via duck-typing.
// Handles both direct Safe submitters (safeAddress) and ICA submitters with a
// nested internalSubmitter that holds the Safe address.
function extractSafeAddressFromSubmitter(meta: unknown): string {
  if (meta == null || typeof meta !== 'object') return '';
  const obj = meta as Record<string, unknown>;
  if (typeof obj.safeAddress === 'string') return obj.safeAddress;
  const inner = obj.internalSubmitter;
  if (inner != null && typeof inner === 'object') {
    const innerObj = inner as Record<string, unknown>;
    if (typeof innerObj.safeAddress === 'string') return innerObj.safeAddress;
  }
  return '';
}

/**
 * True when the submitter materializes its batch into a payload/file artifact
 * (or wraps one) instead of broadcasting transactions live. For these submitters
 * re-running submit() just rebuilds the artifact, so merging fee txs into the
 * main submission is safe and collapses to a single bundle / callRemote. Live
 * broadcasters (e.g. JSON_RPC, Gnosis Safe propose) are excluded so fee failures
 * cannot trigger a retried rebroadcast of already-submitted main txs.
 */
function submitterProducesPayload(
  submitter: ExtendedSubmissionStrategy['submitter'] | undefined,
): boolean {
  if (!submitter) return false;
  switch (submitter.type) {
    case CustomTxSubmitterType.FILE:
    case TxSubmitterType.GNOSIS_TX_BUILDER:
      return true;
    case TxSubmitterType.INTERCHAIN_ACCOUNT:
      return submitterProducesPayload(submitter.internalSubmitter);
    case TxSubmitterType.TIMELOCK_CONTROLLER:
      return submitterProducesPayload(submitter.proposerSubmitter);
    default:
      return false;
  }
}

/**
 * Submits a per-chain batch through the chain's submitter.
 *
 * A submitter is typed for a single protocol, so its submit() expects
 * Annotated<ProtocolTransaction<ProtocolType>>[]. Warp apply collects a
 * heterogeneous TypedAnnotatedTransaction[] that is homogeneous per chain at
 * runtime, but TS can't prove the union-of-annotated vs annotated-of-union
 * equivalence. The element-type assertion below narrows that single boundary
 * (still type-checked against the submit signature — not `any`).
 */
function submitChainBatch(
  submitter: TxSubmitterBuilder<ProtocolType>,
  txs: TypedAnnotatedTransaction[],
): ReturnType<TxSubmitterBuilder<ProtocolType>['submit']> {
  return submitter.submit(
    ...(txs as Annotated<ProtocolTransaction<ProtocolType>>[]),
  );
}

/**
 * Submits transactions for a single chain and handles receipts/self-relay.
 * Returns Safe TX Builder payloads for main and fee when dedicated submitters produced them,
 * so callers can merge payloads across chains into combined files per chain ID.
 */
async function submitChainTransactions(
  params: WarpApplyParams,
  chain: ChainName,
  transactions: TypedAnnotatedTransaction[],
  feeTxs: TypedAnnotatedTransaction[],
  ownershipTxs: TypedAnnotatedTransaction[],
  isExtendedChain: boolean,
): Promise<ChainTxPayloads> {
  const protocol = params.context.multiProvider.getProtocol(chain);
  const safePayloads: SafeTxBuilderPayload[] = [];
  let returnedFeeError: string | undefined;

  // Read safe addresses once; used to key combined bundles by (chainId, safeAddress)
  // so payloads for two different Safes on the same origin chain stay separate.
  const chainStrategyEntry = params.strategyUrl
    ? readChainSubmissionStrategy(params.strategyUrl)[chain]
    : undefined;
  const mainSafeAddress = extractSafeAddressFromSubmitter(
    chainStrategyEntry?.submitter,
  );
  const feeSafeAddress = extractSafeAddressFromSubmitter(
    chainStrategyEntry?.feeSubmitter ?? chainStrategyEntry?.submitter,
  );

  // Fee-contract-owner txs are merged into the main submission only when there is
  // no dedicated feeSubmitter AND the main submitter materializes a payload/file
  // artifact (e.g. Safe TX Builder, or an ICA wrapping one). For those, merging
  // collapses everything into a single bundle / callRemote and re-running submit()
  // just rebuilds the artifact. When the main submitter broadcasts live (e.g.
  // JSON_RPC), merging would fold fee txs into the retried main submit() so a fee
  // failure could rebroadcast already-mined router txs — instead those fee txs are
  // submitted separately through the isolated try/catch below.
  const hasDedicatedFeeSubmitter = !isNullish(chainStrategyEntry?.feeSubmitter);
  const mergeFeeIntoMain =
    !hasDedicatedFeeSubmitter &&
    feeTxs.length > 0 &&
    submitterProducesPayload(chainStrategyEntry?.submitter);
  const mainTransactions = mergeFeeIntoMain
    ? [...transactions, ...feeTxs]
    : transactions;

  await retryAsync(
    async () => {
      const { submitter, config } = await getSubmitterByStrategy({
        chain,
        context: params.context,
        strategyUrl: params.strategyUrl,
        isExtendedChain,
      });
      const transactionReceipts =
        mainTransactions.length > 0
          ? await submitChainBatch(submitter, mainTransactions)
          : undefined;

      if (isSafeTxBuilderPayload(transactionReceipts)) {
        safePayloads.push({
          ...transactionReceipts,
          meta: { ...transactionReceipts.meta, _safeAddress: mainSafeAddress },
        });
      }

      if (!isSafeTxBuilderPayload(transactionReceipts)) {
        if (!isEVMLike(protocol)) {
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

        if (canRelay.relay) {
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
        }
      }

      // Runs whenever fee txs were NOT merged into the main submission: either a
      // dedicated feeSubmitter is configured, or the main submitter broadcasts
      // live (so fee txs are kept out of the retried main submit() and isolated
      // here). Intentionally wrapped in try/catch so a fee failure does NOT bubble
      // up to retryAsync and re-run the main submit block (which would rebroadcast
      // already-submitted main txs); the failure is surfaced as a soft warning via
      // returnedFeeError instead.
      if (!mergeFeeIntoMain && feeTxs.length > 0) {
        try {
          const dedicatedFeeSubmitter = await getFeeSubmitterByStrategy({
            chain,
            context: params.context,
            strategyUrl: params.strategyUrl,
          });
          // Fall back to the main submitter when no dedicated feeSubmitter is
          // configured (live-broadcast strategies that opted out of merging).
          const feeSubmitter = dedicatedFeeSubmitter ?? submitter;
          const feeSafeAddressForBundle = dedicatedFeeSubmitter
            ? feeSafeAddress
            : mainSafeAddress;
          const feeReceipts = await submitChainBatch(feeSubmitter, feeTxs);
          if (isSafeTxBuilderPayload(feeReceipts)) {
            safePayloads.push({
              ...feeReceipts,
              meta: {
                ...feeReceipts.meta,
                _safeAddress: feeSafeAddressForBundle,
              },
            });
          }
          if (
            feeReceipts &&
            !isSafeTxBuilderPayload(feeReceipts) &&
            isEVMLike(protocol)
          ) {
            const feeReceiptPath = `${params.receiptsDir}/${chain}-fee-${Date.now()}-receipts.json`;
            writeYamlOrJson(feeReceiptPath, feeReceipts);
            logGreen(
              `Fee transaction receipts for ${protocol} chain ${chain} successfully written to ${feeReceiptPath}`,
            );
          }
        } catch (error) {
          returnedFeeError =
            error instanceof Error ? error.message : String(error);
          warnYellow(
            `Error when submitting fee transactions for ${chain}`,
            error,
          );
        }
      }

      // Submit ownership txs last — after fee txs — so onlyOwner calls (e.g.
      // setFeeRecipient) execute before ownership is transferred to a new address.
      if (ownershipTxs.length > 0) {
        const ownershipReceipts = await submitChainBatch(
          submitter,
          ownershipTxs,
        );
        if (isSafeTxBuilderPayload(ownershipReceipts)) {
          safePayloads.push({
            ...ownershipReceipts,
            meta: {
              ...ownershipReceipts.meta,
              _safeAddress: mainSafeAddress,
            },
          });
        } else if (ownershipReceipts && isEVMLike(protocol)) {
          const ownershipReceiptPath = `${params.receiptsDir}/${chain}-ownership-${Date.now()}-receipts.json`;
          writeYamlOrJson(ownershipReceiptPath, ownershipReceipts);
          logGreen(
            `Ownership transaction receipts for ${protocol} chain ${chain} successfully written to ${ownershipReceiptPath}`,
          );
        }
      }
    },
    5, // attempts
    100, // baseRetryMs
  );

  return { safePayloads, feeError: returnedFeeError };
}

/**
 * Submits a set of transactions to the specified chain and outputs transaction receipts
 */
async function submitWarpApplyTransactions(
  params: WarpApplyParams,
  updateTransactions: ChainMap<TypedAnnotatedTransaction[]>,
  feeUpdateTransactions: ChainMap<TypedAnnotatedTransaction[]> = {},
  ownershipUpdateTransactions: ChainMap<TypedAnnotatedTransaction[]> = {},
): Promise<void> {
  const { extendedChains } = getWarpRouteExtensionDetails(
    params.warpCoreConfig,
    params.warpDeployConfig,
  );

  // Group chains by protocol type for appropriate parallelization
  // EVM chains can run in parallel (each chain has an independent nonce)
  // Non-EVM chains (e.g., Cosmos) must run sequentially because when the same
  // private key is used across multiple chains, parallel tx submission causes
  // sequence number conflicts (both txs query sequence N, one succeeds with N,
  // the other fails expecting N+1)
  const allChains = new Set([
    ...Object.keys(updateTransactions),
    ...Object.keys(feeUpdateTransactions),
    ...Object.keys(ownershipUpdateTransactions),
  ]);
  const chains = [...allChains];
  const evmChains = chains.filter((chain) =>
    isEVMLike(params.context.multiProvider.getProtocol(chain)),
  );
  const nonEvmChains = chains.filter(
    (chain) => !isEVMLike(params.context.multiProvider.getProtocol(chain)),
  );

  const failures: string[] = [];
  const feeFailures: string[] = [];
  const isExtended = (chain: string) => extendedChains.includes(chain);
  const allPayloads: SafeTxBuilderPayload[] = [];

  const collectPayloads = (
    { safePayloads, feeError }: ChainTxPayloads,
    chain: string,
  ) => {
    allPayloads.push(...safePayloads);
    if (feeError) feeFailures.push(`${chain}: ${feeError}`);
  };

  // Submit EVM chains in parallel (they have independent signers)
  if (evmChains.length > 0) {
    const { fulfilled, rejected } = await mapAllSettled(
      evmChains,
      (chain) =>
        submitChainTransactions(
          params,
          chain,
          updateTransactions[chain] ?? [],
          feeUpdateTransactions[chain] ?? [],
          ownershipUpdateTransactions[chain] ?? [],
          isExtended(chain),
        ),
      (chain) => chain,
    );

    for (const [chain, error] of rejected) {
      rootLogger.debug(
        `Error in submitWarpApplyTransactions for ${chain}`,
        error,
      );
      errorRed(
        `Failed to submit warp apply transactions for ${chain}: ${error.message}`,
      );
      failures.push(chain);
    }
    for (const [chain, payloads] of fulfilled) collectPayloads(payloads, chain);
  }

  // Submit non-EVM chains sequentially (they may share signers)
  for (const chain of nonEvmChains) {
    try {
      collectPayloads(
        await submitChainTransactions(
          params,
          chain,
          updateTransactions[chain] ?? [],
          feeUpdateTransactions[chain] ?? [],
          ownershipUpdateTransactions[chain] ?? [],
          isExtended(chain),
        ),
        chain,
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      rootLogger.debug(`Error in submitWarpApplyTransactions for ${chain}`, e);
      errorRed(
        `Failed to submit warp apply transactions for ${chain}: ${errorMessage}`,
      );
      failures.push(chain);
    }
  }

  // Write whatever Safe payloads succeeded before surfacing any chain failures,
  // so a partial success (e.g. chain A ok, chain B failed) doesn't lose chain A's bundle.
  writeCombinedBundles(params.receiptsDir, allPayloads);

  if (failures.length > 0) {
    throw new Error(
      `Warp apply transaction submission failed for chain(s): ${failures.join(', ')}`,
    );
  }

  if (feeFailures.length > 0) {
    warnYellow(
      `Fee transaction submission failed for the following chain(s) — main transactions were NOT affected:\n${feeFailures.join('\n')}`,
    );
  }
}

function writeCombinedBundles(
  receiptsDir: string,
  payloads: SafeTxBuilderPayload[],
): void {
  // Group by (chainId, safeAddress) — payloads for different Safes on the same origin
  // chain stay separate; main and fee payloads for the same Safe are merged together.
  const byGroup = new Map<string, SafeTxBuilderPayload[]>();
  for (const payload of payloads) {
    const safeAddress = (payload.meta._safeAddress as string) ?? '';
    const groupKey = `${payload.chainId}:${safeAddress}`;
    const list = byGroup.get(groupKey) ?? [];
    list.push(payload);
    byGroup.set(groupKey, list);
  }
  for (const [groupKey, group] of byGroup.entries()) {
    const [chainId, safeAddress] = groupKey.split(':');
    const combinedMeta: Record<string, unknown> = { ...group[0].meta };
    delete combinedMeta._safeAddress;
    const combined: SafeTxBuilderPayload = {
      version: group[0].version,
      chainId,
      meta: combinedMeta,
      transactions: group.flatMap((p) => p.transactions),
    };
    const safeSegment = safeAddress ? `-safe${safeAddress.slice(0, 8)}` : '';
    const path = `${receiptsDir}/combined-chainId${chainId}${safeSegment}-${Date.now()}-receipts.json`;
    writeYamlOrJson(path, combined);
    logGreen(
      `Combined ${group.length} bundle(s) (${combined.transactions.length} txs) for chain ID ${chainId} written to ${path}`,
    );
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
    [ProtocolType.Tron]: {
      file: (_multiProvider: MultiProvider, metadata: any) => {
        return new EV5FileSubmitter(metadata);
      },
    },
    [ProtocolType.Ethereum]: {
      file: (_multiProvider: MultiProvider, metadata: any) => {
        return new EV5FileSubmitter(metadata);
      },
    },
  };

  // Only add non-Ethereum protocol factories if we have an alt VM signer
  if (!isEVMLike(protocol)) {
    const signer = mustGet(altVmSigners, chain);
    additionalSubmitterFactories[protocol] = {
      jsonRpc: () => {
        return new AltVMJsonRpcSubmitter(signer, {
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

type CombineRouteConfig = {
  id: string;
  coreConfig: WarpCoreConfig;
  deployConfig: WarpRouteDeployConfig;
};

type CanonicalWholeTokenRatio = {
  numerator: bigint;
  denominator: bigint;
};

function formatScaleForLogs(
  scale: WarpCoreConfig['tokens'][number]['scale'],
): string {
  if (!scale) return '1';
  const normalizedScale = normalizeScale(scale);
  if (normalizedScale.denominator === 1n) {
    return normalizedScale.numerator.toString();
  }
  return `${normalizedScale.numerator}/${normalizedScale.denominator}`;
}

function getCanonicalWholeTokenRatio(
  token: WarpCoreConfig['tokens'][number],
): CanonicalWholeTokenRatio {
  const normalizedScale = normalizeScale(token.scale);
  const oneTokenBaseUnits = 10n ** BigInt(token.decimals);
  return {
    numerator: oneTokenBaseUnits * normalizedScale.numerator,
    denominator: normalizedScale.denominator,
  };
}

function assertCombineRoutesAreValid(routes: CombineRouteConfig[]): void {
  for (const route of routes) {
    const invalidDeployChains = Object.entries(route.deployConfig)
      .filter(([, chainConfig]) => !isCrossCollateralTokenConfig(chainConfig))
      .map(([chain]) => chain);
    assert(
      invalidDeployChains.length === 0,
      `Route "${route.id}" contains non-CrossCollateralRouter deploy configs for chain(s): ${invalidDeployChains.join(', ')}`,
    );

    const invalidCoreTokens = route.coreConfig.tokens.filter(
      (token) => !TOKEN_CROSS_COLLATERAL_STANDARDS.has(token.standard),
    );
    assert(
      invalidCoreTokens.length === 0,
      `Route "${route.id}" contains non-CrossCollateralRouter warp config token(s): ${invalidCoreTokens
        .map((token) => `${token.chainName}:${token.addressOrDenom}`)
        .join(', ')}`,
    );
  }

  const tokensByChain = new Map<
    string,
    Array<{ routeId: string; token: WarpCoreConfig['tokens'][number] }>
  >();
  for (const route of routes) {
    for (const token of route.coreConfig.tokens) {
      const chainTokens = tokensByChain.get(token.chainName) ?? [];
      chainTokens.push({ routeId: route.id, token });
      tokensByChain.set(token.chainName, chainTokens);
    }
  }

  for (const [chainName, chainTokens] of tokensByChain.entries()) {
    if (chainTokens.length <= 1) continue;

    const [base, ...rest] = chainTokens;
    const baseRatio = getCanonicalWholeTokenRatio(base.token);

    for (const candidate of rest) {
      const candidateRatio = getCanonicalWholeTokenRatio(candidate.token);
      const isCompatible =
        baseRatio.numerator * candidateRatio.denominator ===
        candidateRatio.numerator * baseRatio.denominator;

      assert(
        isCompatible,
        `Incompatible decimals/scale on chain "${chainName}" between route "${base.routeId}" (${base.token.symbol}, decimals=${base.token.decimals}, scale=${formatScaleForLogs(base.token.scale)}) and route "${candidate.routeId}" (${candidate.token.symbol}, decimals=${candidate.token.decimals}, scale=${formatScaleForLogs(candidate.token.scale)}).`,
      );
    }
  }
}

/**
 * Combines multiple warp routes into a single merged WarpCoreConfig and updates
 * each route's deploy config with cross-route crossCollateralRouters.
 */
export async function runWarpRouteCombine({
  context,
  routeIds,
  outputWarpRouteId,
}: {
  context: WriteCommandContext;
  routeIds: string[];
  outputWarpRouteId: string;
}): Promise<void> {
  assert(routeIds.length >= 2, 'At least 2 route IDs are required to combine');
  assert(
    routeIds.every((id) => id.length > 0),
    'Route IDs must be non-empty strings',
  );
  assert(
    new Set(routeIds).size === routeIds.length,
    'Duplicate route IDs are not allowed',
  );

  // 1. Read each route's WarpCoreConfig and deploy config
  const routes: CombineRouteConfig[] = [];

  for (const id of routeIds) {
    const coreConfig = await context.registry.getWarpRoute(id);
    assert(coreConfig, `Warp route "${id}" not found in registry`);
    const deployConfigRaw = await context.registry.getWarpDeployConfig(id);
    const deployConfig = WarpRouteDeployConfigSchema.parse(deployConfigRaw);
    routes.push({
      id,
      coreConfig,
      deployConfig,
    });
  }

  assertCombineRoutesAreValid(routes);

  // 2. For each route, update crossCollateralRouters with routers from other routes
  for (const route of routes) {
    for (const [chain, chainConfig] of Object.entries(
      route.deployConfig,
    ) as Array<[string, HypTokenRouterConfig]>) {
      if (!isCrossCollateralTokenConfig(chainConfig)) continue;

      const crossCollateralRouters: Record<string, Set<string>> = {};

      // Look at all OTHER routes
      for (const otherRoute of routes) {
        if (otherRoute.id === route.id) continue;

        // For each token in the other route, add its router to this route's crossCollateralRouters
        for (const otherToken of otherRoute.coreConfig.tokens) {
          const otherDomain = context.multiProvider
            .getDomainId(otherToken.chainName)
            .toString();
          assert(
            otherToken.addressOrDenom,
            `CrossCollateralRouter token missing addressOrDenom on ${otherToken.chainName}`,
          );
          const otherRouter = addressToBytes32(otherToken.addressOrDenom);

          crossCollateralRouters[otherDomain] ??= new Set();
          crossCollateralRouters[otherDomain].add(otherRouter);
        }
      }

      const reconciledEnrolledRouters = Object.fromEntries(
        Object.entries(crossCollateralRouters).map(([domain, routers]) => [
          domain,
          [...routers],
        ]),
      );

      const routersRemovedByCombine = Object.entries(
        chainConfig.crossCollateralRouters ?? {},
      ).reduce((acc, [domain, routers]) => {
        const enrolledAfterCombine = new Set(
          reconciledEnrolledRouters[domain] ?? [],
        );
        return (
          acc +
          routers.filter((router) => !enrolledAfterCombine.has(router)).length
        );
      }, 0);

      if (routersRemovedByCombine > 0) {
        warnYellow(
          `Combining route "${route.id}" on chain "${chain}" will remove ${routersRemovedByCombine} enrolled router(s) not present in --routes. They will be unenrolled on next "warp apply".`,
        );
      }

      chainConfig.crossCollateralRouters =
        Object.keys(reconciledEnrolledRouters).length > 0
          ? reconciledEnrolledRouters
          : undefined;
    }

    // Write updated deploy config back
    await context.registry.addWarpRouteConfig(route.deployConfig, {
      warpRouteId: route.id,
    });
    log(`Updated deploy config for route "${route.id}"`);
  }

  // 3. Create merged WarpCoreConfig with all tokens
  const mergedConfig: WarpCoreConfig = { tokens: [] };
  const seenTokens = new Set<string>();

  for (const route of routes) {
    for (const token of route.coreConfig.tokens) {
      const key = `${token.chainName}:${token.addressOrDenom}`;
      assert(
        !seenTokens.has(key),
        `Duplicate token ${key} across input routes`,
      );
      seenTokens.add(key);
      mergedConfig.tokens.push({ ...token, connections: [] });
    }
  }

  // Full mesh connections (every token → every other token)
  fullyConnectTokens(mergedConfig, context.multiProvider);

  // 4. Write merged WarpCoreConfig
  const mergedId = outputWarpRouteId;
  await context.registry.addWarpRoute(mergedConfig, { warpRouteId: mergedId });

  logGreen(`✅ Combined ${routes.length} routes into "${mergedId}"`);
  log(
    `Run "warp apply" for each route to apply on-chain enrollment:\n${routes.map((r) => `  hyperlane warp apply --warp-route-id ${r.id}`).join('\n')}`,
  );
}
