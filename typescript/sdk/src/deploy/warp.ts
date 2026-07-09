import {
  MailboxClient__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  createHookWriter,
  createIsmWriter,
  createWarpTokenWriter,
  validateIsmConfig,
} from '@hyperlane-xyz/deploy-sdk';
import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  HookConfig as ProviderHookConfig,
  hookConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  IsmConfig as ProviderIsmConfig,
  ismConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  CollateralWarpConfig,
  CrossCollateralWarpConfig,
  NativeWarpConfig,
  SyntheticWarpConfig,
  TokenType as ProviderTokenType,
  WarpConfig as ProviderWarpConfig,
  warpConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  Address,
  addressToBytes32,
  assert,
  isNullish,
  isObjEmpty,
  mapAllSettled,
  mustGet,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ExplorerLicenseType } from '../block-explorer/etherscan.js';
import { CCIPContractCache } from '../ccip/utils.js';
import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { EvmHookModule } from '../hook/EvmHookModule.js';
import { HookConfig } from '../hook/types.js';
import { hookTreeContainsRateLimited } from '../hook/utils.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { IsmConfig } from '../ism/types.js';
import { altVmChainLookup } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { TypedAnnotatedTransaction } from '../providers/ProviderType.js';
import {
  DestinationGas,
  RemoteRouters,
  resolveRouterMapConfig,
} from '../router/types.js';
import { EvmWarpModule } from '../token/EvmWarpModule.js';
import { MAX_GAS_OVERHEAD, TokenType, gasOverhead } from '../token/config.js';
import { HypERC20Factories, hypERC20factories } from '../token/contracts.js';
import { HypERC20Deployer, HypERC721Deployer } from '../token/deploy.js';
import {
  HypTokenRouterConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainMap } from '../types.js';
import {
  extractIsmAndHookFactoryAddresses,
  ismTreeContainsRateLimited,
} from '../utils/ism.js';

import { HyperlaneProxyFactoryDeployer } from './HyperlaneProxyFactoryDeployer.js';
import { ContractVerifier } from './verify/ContractVerifier.js';

type ChainAddresses = Record<string, string>;

type RateLimitedHookDeployInput = {
  hookConfig: HookConfig;
  chainAddresses: ChainAddresses;
  ccipContractCache: CCIPContractCache;
  proxyAdminAddress: Address | undefined;
};

const SUPPORTED_ALTVM_TOKEN_TYPES = new Set<TokenType>([
  TokenType.synthetic,
  TokenType.collateral,
  TokenType.native,
  TokenType.crossCollateral,
]);

export function validateWarpConfigForAltVM(
  config: WarpRouteDeployConfigMailboxRequired[string],
  chain: string,
): ProviderWarpConfig {
  if (!SUPPORTED_ALTVM_TOKEN_TYPES.has(config.type)) {
    const supportedTypes = Array.from(SUPPORTED_ALTVM_TOKEN_TYPES).join(', ');
    throw new Error(
      `Unsupported token type '${config.type}' for Alt-VM chain '${chain}'.\n` +
        `Supported token types: ${supportedTypes}.`,
    );
  }

  if (config.interchainSecurityModule) {
    validateIsmConfig(
      config.interchainSecurityModule as ProviderIsmConfig | string,
      chain,
      'warp config',
    );
  }

  let scale: number | undefined;
  if (typeof config.scale === 'number') {
    scale = config.scale;
  } else if (!isNullish(config.scale)) {
    assert(
      Number(config.scale.denominator) !== 0,
      'scale denominator must be non-zero',
    );

    scale = Number(config.scale.numerator) / Number(config.scale.denominator);
  }

  const baseConfig = {
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule: config.interchainSecurityModule as
      | ProviderIsmConfig
      | string
      | undefined,
    hook: config.hook as ProviderHookConfig | string | undefined,
    remoteRouters: config.remoteRouters,
    destinationGas: config.destinationGas,
    scale,
  };

  switch (config.type) {
    case TokenType.collateral: {
      if (!config.token) {
        throw new Error(
          `Collateral token config for chain '${chain}' must specify 'token' address`,
        );
      }
      const result: CollateralWarpConfig = {
        ...baseConfig,
        type: ProviderTokenType.collateral,
        token: config.token,
      };
      return result;
    }
    case TokenType.synthetic: {
      const result: SyntheticWarpConfig = {
        ...baseConfig,
        type: ProviderTokenType.synthetic,
        name: config.name,
        symbol: config.symbol,
        decimals: config.decimals,
        metadataUri: config.metadataUri,
      };
      return result;
    }
    case TokenType.crossCollateral: {
      if (!config.token) {
        throw new Error(
          `Cross-collateral token config for chain '${chain}' must specify 'token' address`,
        );
      }
      const result: CrossCollateralWarpConfig = {
        ...baseConfig,
        type: ProviderTokenType.crossCollateral,
        token: config.token,
        crossCollateralRouters: config.crossCollateralRouters,
      };
      return result;
    }
    case TokenType.native: {
      const result: NativeWarpConfig = {
        ...baseConfig,
        type: ProviderTokenType.native,
      };
      return result;
    }
    default:
      throw new Error(
        `Unhandled token type '${config.type}' for Alt-VM chain '${chain}'.`,
      );
  }
}

// Subclass that injects rate-limited hook deployment between configureClients and
// transferOwnership so that setHook() is called while the deployer signer still owns the token.
class RateLimitedHookERC20Deployer extends HypERC20Deployer {
  constructor(
    multiProvider: MultiProvider,
    ismFactory: HyperlaneIsmFactory | undefined,
    contractVerifier: ContractVerifier | undefined,
    private readonly preTransferFn: (
      deployedTokens: ChainMap<Address>,
    ) => Promise<void>,
  ) {
    super(multiProvider, ismFactory, contractVerifier);
  }

  protected override async beforeTransferOwnership(
    contractsMap: HyperlaneContractsMap<HypERC20Factories>,
  ): Promise<void> {
    await this.preTransferFn(
      objMap(contractsMap, (_, contracts) => getRouter(contracts).address),
    );
  }
}

export async function executeWarpDeploy(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  registryAddresses: ChainMap<ChainAddresses>,
  apiKeys: ChainMap<string>,
): Promise<ChainMap<Address>> {
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

  // Capture ISM configs that contain a RATE_LIMITED node before resolveWarpIsmAndHook
  // runs — that function replaces each chain's ISM field with the deployed address,
  // but RATE_LIMITED ISMs (and any composite ISM containing one) are skipped there
  // because the constructor requires the token address (recipient), which doesn't
  // exist yet.  They are wired inside TokenDeployer.deploy() before ownership is
  // transferred so that setInterchainSecurityModule succeeds regardless of config.owner.
  const rateLimitedSnapshot: ChainMap<IsmConfig> = {};
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    if (typeof config.interchainSecurityModule !== 'object') continue;
    const ism = config.interchainSecurityModule;
    if (!ismTreeContainsRateLimited(ism)) continue;
    const protocol = multiProvider.getProtocol(chain);
    assert(
      protocol === ProtocolType.Ethereum || protocol === ProtocolType.Tron,
      `RateLimitedIsm is only supported on Ethereum and Tron chains, but chain ${chain} has protocol ${protocol}`,
    );
    // Store the full ISM tree as-is; recipient + owner defaults are applied
    // uniformly in setRateLimitedIsms via setRateLimitedIsmRecipient.
    rateLimitedSnapshot[chain] = ism;
  }

  // Hooks containing RATE_LIMITED need the token router address as sender, so they are deferred
  // until after token deployment. resolveWarpIsmAndHook populates this map (EVM/Tron only) and
  // returns undefined for those hooks, causing them to be set later via setHook().
  const rateLimitedHookSnapshots: ChainMap<RateLimitedHookDeployInput> = {};

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism and/or hook address as a string
  const modifiedConfig = await resolveWarpIsmAndHook(
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    ismFactoryDeployer,
    contractVerifier,
    rateLimitedHookSnapshots,
  );

  // Initialize with unsupported chains so that they are enrolled
  let deployedContracts: ChainMap<Address> = objMap(
    objFilter(
      warpDeployConfig,
      (
        _chain,
        config,
      ): config is WarpRouteDeployConfigMailboxRequired[string] =>
        !!config.foreignDeployment,
    ),
    (chain, config) => {
      assert(
        config.foreignDeployment,
        `Expected foreignDeployment field to be defined on ${chain} after filtering`,
      );

      return config.foreignDeployment;
    },
  );

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
      (
        chainName,
        config,
      ): config is WarpRouteDeployConfigMailboxRequired[string] =>
        multiProvider.getProtocol(chainName) === protocol &&
        !config.foreignDeployment,
    );

    if (isObjEmpty(protocolSpecificConfig)) {
      continue;
    }

    switch (protocol) {
      case ProtocolType.Tron:
      case ProtocolType.Ethereum: {
        const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
          registryAddresses,
          multiProvider,
          undefined,
          contractVerifier,
        );

        assert(
          !warpDeployConfig.isNft || isObjEmpty(rateLimitedHookSnapshots),
          'RATE_LIMITED hooks are not supported for NFT warp routes (HypERC721Deployer has no beforeTransferOwnership override)',
        );

        const deployer = warpDeployConfig.isNft
          ? new HypERC721Deployer(multiProvider)
          : isObjEmpty(rateLimitedHookSnapshots)
            ? new HypERC20Deployer(multiProvider, ismFactory, contractVerifier) // TODO: replace with EvmERC20WarpModule
            : new RateLimitedHookERC20Deployer(
                multiProvider,
                ismFactory,
                contractVerifier,
                // Called BEFORE transferOwnership — deployer signer still owns the token here.
                async (deployedTokens) => {
                  const chainSnapshots = objFilter(
                    rateLimitedHookSnapshots,
                    (chain, _v): _v is RateLimitedHookDeployInput =>
                      chain in deployedTokens,
                  );
                  if (isObjEmpty(chainSnapshots)) return;
                  const deployedHooks = await deployAndWireRateLimitedHooks(
                    chainSnapshots,
                    deployedTokens,
                    multiProvider,
                    contractVerifier,
                  );
                  for (const [chain, hookAddress] of Object.entries(
                    deployedHooks,
                  )) {
                    warpDeployConfig[chain].hook = hookAddress;
                  }
                },
              );

        const chainSet = new Set(Object.keys(protocolSpecificConfig));
        const rateLimitedForBatch = objFilter(
          rateLimitedSnapshot,
          (_chain, _ismConfig): _ismConfig is IsmConfig => chainSet.has(_chain),
        );
        const evmContracts = await deployer.deploy(
          protocolSpecificConfig,
          rateLimitedForBatch,
        );
        deployedContracts = {
          ...deployedContracts,
          ...objMap(
            evmContracts as HyperlaneContractsMap<HypERC20Factories>,
            (_, contracts) => getRouter(contracts).address,
          ),
        };

        break;
      }
      default: {
        const chainLookup = altVmChainLookup(multiProvider);

        const deployResults: ChainMap<Address> = {};
        for (const chain of objKeys(protocolSpecificConfig)) {
          const config = mustGet(protocolSpecificConfig, chain);
          const signer = mustGet(altVmSigners, chain);
          const chainMetadata = chainLookup.getChainMetadata(chain);
          const writer = createWarpTokenWriter(
            chainMetadata,
            chainLookup,
            signer,
          );

          const artifact = warpConfigToArtifact(
            validateWarpConfigForAltVM(config, chain),
            chainLookup,
          );

          const [deployed] = await writer.create(artifact);
          deployResults[chain] = deployed.deployed.address;
        }

        deployedContracts = {
          ...deployedContracts,
          ...deployResults,
        };

        break;
      }
    }
  }

  return deployedContracts;
}

async function deployAndWireRateLimitedHooks(
  snapshots: ChainMap<RateLimitedHookDeployInput>,
  deployedTokens: ChainMap<Address>,
  multiProvider: MultiProvider,
  contractVerifier?: ContractVerifier,
): Promise<ChainMap<Address>> {
  return promiseObjAll(
    objMap(
      snapshots,
      async (
        chain,
        { hookConfig, chainAddresses, ccipContractCache, proxyAdminAddress },
      ) => {
        const tokenAddress = mustGet(deployedTokens, chain);
        assert(chainAddresses, `No registry addresses for ${chain}`);

        const resolvedProxyAdminAddress: Address =
          proxyAdminAddress ??
          (
            await multiProvider.handleDeploy(
              chain,
              new ProxyAdmin__factory(),
              [],
            )
          ).address;

        const evmHookModule = await EvmHookModule.create({
          chain,
          multiProvider,
          coreAddresses: {
            mailbox: chainAddresses.mailbox,
            proxyAdmin: resolvedProxyAdminAddress,
            rateLimitedSender: tokenAddress,
          },
          config: hookConfig,
          ccipContractCache,
          proxyFactoryFactories:
            extractIsmAndHookFactoryAddresses(chainAddresses),
          contractVerifier,
        });

        const { deployedHook } = evmHookModule.serialize();
        assert(
          deployedHook,
          `Failed to get deployed hook address for ${chain}`,
        );

        rootLogger.info(
          `Wiring RateLimitedHook ${deployedHook} to token ${tokenAddress} on ${chain}`,
        );
        const txOverrides = multiProvider.getTransactionOverrides(chain);
        const signer = multiProvider.getSigner(chain);
        const token = MailboxClient__factory.connect(tokenAddress, signer);
        await multiProvider.handleTx(
          chain,
          token.setHook(deployedHook, txOverrides),
        );

        return deployedHook;
      },
    ),
  );
}

async function resolveWarpIsmAndHook(
  warpConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  registryAddresses: ChainMap<ChainAddresses>,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
  contractVerifier: ContractVerifier,
  rateLimitedHookSnapshots: ChainMap<RateLimitedHookDeployInput>,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      const ccipContractCache = new CCIPContractCache(registryAddresses);
      const chainAddresses = registryAddresses[chain];

      if (!chainAddresses) {
        throw new Error(`Registry factory addresses not found for ${chain}.`);
      }

      const ism = await createWarpIsm({
        ccipContractCache,
        chain,
        chainAddresses,
        multiProvider,
        altVmSigners,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      }); // TODO write test

      const hook = await createWarpHook({
        ccipContractCache,
        chain,
        chainAddresses,
        multiProvider,
        altVmSigners,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
        rateLimitedHookSnapshots,
      });

      // Spread instead of mutating config in place — the caller holds a reference
      // to warpDeployConfig[chain] and uses it for registry persistence; mutating
      // would wipe the RATE_LIMITED stanza from the persisted YAML.
      return {
        ...config,
        interchainSecurityModule: ism,
        hook,
      };
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
  multiProvider,
  altVmSigners,
  contractVerifier,
  warpConfig,
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  multiProvider: MultiProvider;
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
}): Promise<IsmConfig | undefined> {
  const { interchainSecurityModule } = warpConfig;
  if (
    !interchainSecurityModule ||
    typeof interchainSecurityModule === 'string'
  ) {
    rootLogger.info(
      `Config Ism is ${
        !interchainSecurityModule ? 'empty' : interchainSecurityModule
      }, skipping deployment.`,
    );
    return interchainSecurityModule;
  }

  // RateLimitedIsm has a chicken-and-egg problem: the constructor requires the
  // token (recipient) address, but ISMs are deployed here — before the token exists.
  // We skip any ISM tree that contains a RATE_LIMITED node and deploy it later in
  // setRateLimitedIsms() (after the token is deployed), then wire it up via
  // setInterchainSecurityModule().
  if (ismTreeContainsRateLimited(interchainSecurityModule)) {
    rootLogger.info(
      `Skipping ISM deployment for ${chain} (contains RateLimitedIsm), will deploy after token.`,
    );
    return undefined;
  }

  rootLogger.info(`Loading registry factory addresses for ${chain}...`);

  rootLogger.info(
    `Creating ${interchainSecurityModule.type} ISM for token on ${chain} chain...`,
  );

  rootLogger.info(
    `Finished creating ${interchainSecurityModule.type} ISM for token on ${chain} chain.`,
  );

  const protocolType = multiProvider.getProtocol(chain);

  switch (protocolType) {
    case ProtocolType.Tron:
    case ProtocolType.Ethereum: {
      const evmIsmModule = await EvmIsmModule.create({
        chain,
        mailbox: chainAddresses.mailbox,
        multiProvider: multiProvider,
        proxyFactoryFactories:
          extractIsmAndHookFactoryAddresses(chainAddresses),
        config: interchainSecurityModule,
        ccipContractCache,
        contractVerifier,
      });
      const { deployedIsm } = evmIsmModule.serialize();
      return deployedIsm;
    }
    default: {
      const signer = mustGet(altVmSigners, chain);
      const chainLookup = altVmChainLookup(multiProvider);
      const chainMetadata = chainLookup.getChainMetadata(chain);
      const writer = createIsmWriter(chainMetadata, chainLookup, signer);
      const artifact = ismConfigToArtifact(
        // FIXME: not all ISM types are supported yet
        interchainSecurityModule as ProviderIsmConfig,
        chainLookup,
      );
      const [deployed] = await writer.create(artifact);
      return deployed.deployed.address;
    }
  }
}

async function createWarpHook({
  ccipContractCache,
  chain,
  chainAddresses,
  multiProvider,
  altVmSigners,
  contractVerifier,
  warpConfig,
  rateLimitedHookSnapshots,
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  multiProvider: MultiProvider;
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
  rateLimitedHookSnapshots: ChainMap<RateLimitedHookDeployInput>;
}): Promise<HookConfig | undefined> {
  const { hook } = warpConfig;

  if (!hook || typeof hook === 'string') {
    rootLogger.info(
      `Config Hook is ${!hook ? 'empty' : hook}, skipping deployment.`,
    );
    return hook;
  }

  // RATE_LIMITED hooks need the token router address as sender — defer until post-token deploy.
  // Only EVM/Tron support EvmHookModule; foreignDeployment and non-EVM chains cannot wire the hook.
  if (hookTreeContainsRateLimited(hook)) {
    assert(
      !warpConfig.foreignDeployment,
      `RATE_LIMITED hook configured on ${chain} but it is a foreignDeployment — hook cannot be wired post-deploy`,
    );
    const protocol = multiProvider.getProtocol(chain);
    assert(
      protocol === ProtocolType.Ethereum || protocol === ProtocolType.Tron,
      `RATE_LIMITED hook is only supported on EVM/Tron chains; ${chain} uses protocol ${protocol}`,
    );
    rootLogger.info(
      `RATE_LIMITED hook on ${chain} — deferring deployment until after token deployment`,
    );
    rateLimitedHookSnapshots[chain] = {
      hookConfig: hook,
      chainAddresses,
      ccipContractCache,
      proxyAdminAddress: warpConfig.proxyAdmin?.address,
    };
    return undefined;
  }

  rootLogger.info(`Loading registry factory addresses for ${chain}...`);

  rootLogger.info(`Creating ${hook.type} Hook for token on ${chain} chain...`);

  const protocolType = multiProvider.getProtocol(chain);

  switch (protocolType) {
    case ProtocolType.Tron:
    case ProtocolType.Ethereum: {
      rootLogger.info(`Loading registry factory addresses for ${chain}...`);

      rootLogger.info(
        `Creating ${hook.type} Hook for token on ${chain} chain...`,
      );

      // If config.proxyadmin.address exists, then use that. otherwise deploy a new proxyAdmin
      const proxyAdminAddress: Address =
        warpConfig.proxyAdmin?.address ??
        (await multiProvider.handleDeploy(chain, new ProxyAdmin__factory(), []))
          .address;

      const evmHookModule = await EvmHookModule.create({
        chain,
        multiProvider: multiProvider,
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
      rootLogger.info(
        `Finished creating ${hook.type} Hook for token on ${chain} chain.`,
      );
      const { deployedHook } = evmHookModule.serialize();
      return deployedHook;
    }
    default: {
      const signer = mustGet(altVmSigners, chain);
      const chainLookup = altVmChainLookup(multiProvider);
      const metadata = multiProvider.getChainMetadata(chain);

      // Deploy new hook using artifact writer with mailbox context
      const writer = createHookWriter(metadata, chainLookup, signer, {
        mailbox: chainAddresses.mailbox,
      });
      const artifact = hookConfigToArtifact(
        hook as ProviderHookConfig,
        chainLookup,
      );
      const [deployed] = await writer.create(artifact);
      return deployed.deployed.address;
    }
  }
}

export async function enrollCrossChainRouters(
  {
    multiProvider,
    altVmSigners,
    registryAddresses,
    warpDeployConfig,
  }: {
    multiProvider: MultiProvider;
    altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
    registryAddresses: ChainMap<ChainAddresses>;
    warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  },
  deployedContracts: ChainMap<Address>,
): Promise<ChainMap<TypedAnnotatedTransaction[]>> {
  rootLogger.info(`Start enrolling cross chain routers`);

  const resolvedConfigMap = objMap(warpDeployConfig, (_, config) => ({
    gas: gasOverhead(config.type),
    ...config,
  }));

  const supportedChains = Object.keys(
    objFilter(
      resolvedConfigMap,
      (_, config: any): config is any =>
        !config.foreignDeployment &&
        config.type !== TokenType.collateralDepositAddress &&
        // Bare same-chain ITokenBridge adapter: not a cross-chain router, has no
        // on-chain warp config to derive, so it is never enrolled (like deposit-address).
        config.type !== TokenType.atomicLocalRebalancing,
    ),
  );

  // Process all chains in parallel since they are independent
  const { fulfilled, rejected } = await mapAllSettled(
    supportedChains,
    async (currentChain) => {
      const protocol = multiProvider.getProtocol(currentChain);

      // Start with user-specified remote routers (for chains not in the deployment)
      const userRemoteRouters: RemoteRouters = objMap(
        resolveRouterMapConfig(
          multiProvider,
          resolvedConfigMap[currentChain].remoteRouters ?? {},
        ),
        (_, value) => ({ address: addressToBytes32(value.address) }),
      );

      // Merge: deployed routers take precedence over user-specified
      const remoteRouters: RemoteRouters = {
        ...userRemoteRouters,
        ...Object.fromEntries(
          Object.entries(deployedContracts)
            .filter(([chain, _address]) => chain !== currentChain)
            .map(([chain, address]) => [
              multiProvider.getDomainId(chain).toString(),
              {
                address: addressToBytes32(address),
              },
            ]),
        ),
      };

      // Start with user-specified destination gas
      const userDestinationGas: DestinationGas = resolveRouterMapConfig(
        multiProvider,
        resolvedConfigMap[currentChain].destinationGas ?? {},
      );

      // Default to MAX_GAS_OVERHEAD for user-specified remote routers without explicit destinationGas
      const defaultGasForUserRouters: DestinationGas = objMap(
        userRemoteRouters,
        (domainId) =>
          userDestinationGas[domainId] ?? MAX_GAS_OVERHEAD.toString(),
      );

      // Merge: deployed chain gas takes precedence over defaults and user-specified
      const destinationGas: DestinationGas = {
        ...defaultGasForUserRouters,
        ...Object.fromEntries(
          Object.entries(deployedContracts)
            .filter(([chain, _address]) => chain !== currentChain)
            .map(([chain, _address]) => [
              multiProvider.getDomainId(chain).toString(),
              resolvedConfigMap[chain].gas.toString(),
            ]),
        ),
      };

      for (const domainId of Object.keys(remoteRouters)) {
        rootLogger.debug(
          `Creating enroll remote router transactions with remote domain id ${domainId} and address ${remoteRouters[domainId]} on chain ${currentChain}`,
        );
      }

      let transactions: TypedAnnotatedTransaction[] = [];

      switch (protocol) {
        case ProtocolType.Tron:
        case ProtocolType.Ethereum: {
          const {
            domainRoutingIsmFactory,
            incrementalDomainRoutingIsmFactory,
            staticMerkleRootMultisigIsmFactory,
            staticMessageIdMultisigIsmFactory,
            staticAggregationIsmFactory,
            staticAggregationHookFactory,
            staticMerkleRootWeightedMultisigIsmFactory,
            staticMessageIdWeightedMultisigIsmFactory,
          } = registryAddresses[currentChain];

          const evmWarpModule = new EvmWarpModule(multiProvider, {
            chain: currentChain,
            config: resolvedConfigMap[currentChain],
            addresses: {
              deployedTokenRoute: deployedContracts[currentChain],
              domainRoutingIsmFactory,
              incrementalDomainRoutingIsmFactory,
              staticMerkleRootMultisigIsmFactory,
              staticMessageIdMultisigIsmFactory,
              staticAggregationIsmFactory,
              staticAggregationHookFactory,
              staticMerkleRootWeightedMultisigIsmFactory,
              staticMessageIdWeightedMultisigIsmFactory,
            },
          });

          const actualConfig = await evmWarpModule.read();
          const expectedConfig: HypTokenRouterConfig = {
            ...actualConfig,
            owner: resolvedConfigMap[currentChain].owner,
            remoteRouters,
            destinationGas,
            // For cross-protocol routes (EVM+SVM/Cosmos), the EVM deployer
            // never enrolls non-EVM remote routers, so TokenRouter.domains()=[]
            // at this point. The reader derives RoutingFee.feeContracts from
            // enrolled domains, returning {} which fails
            // RoutingFeeInputConfigSchema validation. Use the deploy config's
            // tokenFee (non-empty feeContracts) so validation passes.
            // EvmTokenFeeModule.update() reads actual on-chain state via
            // routingDestinations and confirms no change is needed.
            ...(resolvedConfigMap[currentChain].tokenFee && {
              tokenFee: resolvedConfigMap[currentChain].tokenFee,
            }),
          };

          transactions = await evmWarpModule.update(expectedConfig, {
            routingDestinations: Object.keys(remoteRouters).map((domain) =>
              parseInt(domain, 10),
            ),
          });

          break;
        }
        default: {
          const signer = mustGet(altVmSigners, currentChain);
          const chainLookup = altVmChainLookup(multiProvider);
          const chainMetadata = chainLookup.getChainMetadata(currentChain);

          const writer = createWarpTokenWriter(
            chainMetadata,
            chainLookup,
            signer,
          );

          const expectedConfig: WarpRouteDeployConfigMailboxRequired[string] = {
            ...resolvedConfigMap[currentChain],
            remoteRouters,
            destinationGas,
          };

          const artifact = warpConfigToArtifact(
            validateWarpConfigForAltVM(expectedConfig, currentChain),
            chainLookup,
          );

          const deployedArtifact = {
            artifactState: ArtifactState.DEPLOYED,
            config: artifact.config,
            deployed: { address: deployedContracts[currentChain] },
          };

          transactions = await writer.update(deployedArtifact);
        }
      }

      rootLogger.debug(
        `Created enroll router update transactions for chain ${currentChain}`,
      );

      return { chain: currentChain, transactions };
    },
    (chain) => chain,
  );

  // Process settled results and collect transactions
  const updateTransactions = {} as ChainMap<TypedAnnotatedTransaction[]>;
  const errors: string[] = [];

  for (const [, result] of fulfilled) {
    if (result.transactions.length) {
      updateTransactions[result.chain] = result.transactions;
    }
  }

  for (const [chain, error] of rejected) {
    rootLogger.error(
      `Failed to create enroll router transactions for chain ${chain}: ${error.message}`,
    );
    errors.push(`${chain}: ${error.message}`);
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to create router enrollment transactions for ${errors.length} chain(s): ${errors.join('; ')}`,
    );
  }

  return updateTransactions;
}

function getRouter(contracts: HyperlaneContracts<HypERC20Factories>) {
  for (const key of objKeys(hypERC20factories)) {
    if (contracts[key]) return contracts[key];
  }
  throw new Error('No matching contract found.');
}
