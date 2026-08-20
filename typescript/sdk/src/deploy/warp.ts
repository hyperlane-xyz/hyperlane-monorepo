import {
  DelayedFlowRouterHookIsm__factory,
  MailboxClient__factory,
  Mailbox__factory,
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
import { type ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
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
  DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY,
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
  eqAddress,
  isEVMLike,
  isNullish,
  isObjEmpty,
  isZeroishAddress,
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
import { tokenFeeInputToFeeConfig } from '../fee/feeConfigMapping.js';
import { EvmHookModule } from '../hook/EvmHookModule.js';
import { HookConfig } from '../hook/types.js';
import {
  hookTreeContainsRateLimited,
  mapHybridHookNodes,
} from '../hook/utils.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import {
  DelayedFlowRouterHookIsmConfig,
  IsmConfig,
  IsmType,
} from '../ism/types.js';
import { altVmChainLookup } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  TypedAnnotatedTransaction,
} from '../providers/ProviderType.js';
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
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  assertTimelockConfigHasNoProxyAdminOwnerOverride,
  WarpRouteDeployConfigMailboxRequiredSchema,
} from '../token/types.js';
import { ChainMap, ChainName } from '../types.js';
import { throwIfNotMissingSelector } from '../utils/contract.js';
import {
  canonicalizeRemoteIsms,
  collectHybridIsmNodes,
  extractIsmAndHookFactoryAddresses,
  ismTreeContainsRateLimited,
  mapHybridIsmNodes,
  resolveDelayedFlowRemoteIsms,
  setRateLimitedIsmRecipient,
} from '../utils/ism.js';

import { HyperlaneProxyFactoryDeployer } from './HyperlaneProxyFactoryDeployer.js';
import {
  WarpHybridPlan,
  hybridLeafDeployConfig,
  planWarpRouteHybrids,
  resolveHybridTrees,
} from './warpHybridPlan.js';
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

/**
 * Builds a `FeeReadContext` directly from a warp deploy config, bypassing
 * `validateWarpConfigForAltVM` + `warpConfigToArtifact` +
 * `buildFeeReadContextFromWarpArtifactConfig`. The read flow only needs the
 * per-domain router set, not the full `ProviderWarpConfig` conversion, so
 * this works for any token type (including EVM-only `xerc20`,
 * `fastCollateral`, etc.) that the AltVM validator would reject.
 *
 * Mirrors `buildFeeReadContextFromWarpArtifactConfig` (provider-sdk) — same
 * `DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY` injection so CC default-router
 * quotes remain visible to the reader.
 */
export function buildFeeReadContextFromWarpDeployConfig(
  config: WarpRouteDeployConfigMailboxRequired[string],
  chainLookup: ChainLookup,
): FeeReadContext {
  const knownRoutersPerDomain: Record<number, Set<string>> = {};

  for (const [chainNameOrId, router] of Object.entries(
    config.remoteRouters ?? {},
  )) {
    const domain = chainLookup.getDomainId(chainNameOrId);
    if (isNullish(domain)) continue;
    const existing = knownRoutersPerDomain[domain] ?? new Set();
    knownRoutersPerDomain[domain] = new Set([
      ...existing,
      addressToBytes32(router.address),
      DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY,
    ]);
  }

  if (
    config.type === TokenType.crossCollateral &&
    config.crossCollateralRouters
  ) {
    for (const [chainNameOrId, routers] of Object.entries(
      config.crossCollateralRouters,
    )) {
      const domain = chainLookup.getDomainId(chainNameOrId);
      if (isNullish(domain)) continue;
      const existing = knownRoutersPerDomain[domain] ?? new Set();
      knownRoutersPerDomain[domain] = new Set([
        ...existing,
        ...routers.map((r) => addressToBytes32(r)),
        DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY,
      ]);
    }
  }

  return { knownRoutersPerDomain };
}

export function validateWarpConfigForAltVM(
  config: WarpRouteDeployConfigMailboxRequired[string],
  chain: string,
  protocol?: ProtocolType,
): ProviderWarpConfig {
  if (!SUPPORTED_ALTVM_TOKEN_TYPES.has(config.type)) {
    const supportedTypes = Array.from(SUPPORTED_ALTVM_TOKEN_TYPES).join(', ');
    throw new Error(
      `Unsupported token type '${config.type}' for Alt-VM chain '${chain}'.\n` +
        `Supported token types: ${supportedTypes}.`,
    );
  }
  assert(
    !config.timelock,
    `Timelock config is not supported on Alt-VM chain '${chain}'.`,
  );

  if (config.interchainSecurityModule) {
    validateIsmConfig(
      config.interchainSecurityModule as ProviderIsmConfig | string,
      chain,
      'warp config',
      protocol,
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
    contractVersion: config.contractVersion,
    fee: config.tokenFee
      ? tokenFeeInputToFeeConfig(config.tokenFee)
      : undefined,
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
        token: config.token,
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

function assertWarpConfigTimelocksSupportedByProtocols({
  multiProvider,
  warpDeployConfig,
}: {
  multiProvider: MultiProvider;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}) {
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    assertTimelockConfigHasNoProxyAdminOwnerOverride(config, chain);
    const protocol = multiProvider.tryGetProtocol(chain);
    assert(
      !config.timelock || (protocol && isEVMLike(protocol)),
      `Timelock config is not supported on Alt-VM chain '${chain}'.`,
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

export type WarpDeployArgs = {
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  multiProvider: MultiProvider;
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
  registryAddresses: ChainMap<ChainAddresses>;
  apiKeys: ChainMap<string>;
};

/**
 * Deploys a WHOLE warp route: its routers, plus the ISM and hook trees they
 * install.
 *
 * Everything decidable from the config is decided before any gas is spent —
 * the full `IsmConfigSchema`/`HookConfigSchema` refinement over both trees, the
 * hybrid hook/ISM pairing (planWarpRouteHybrids), and the route-scoped
 * delayed-flow invariants. The route-scoped ones read the config's chain set as
 * "the route", so they belong to this entry point alone: shrinking the config
 * does not narrow them, it enlarges what counts as outside the route. Use
 * `executeWarpRouteExtensionDeploy` for the chains an extension adds.
 */
export async function executeWarpDeploy(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  registryAddresses: ChainMap<ChainAddresses>,
  apiKeys: ChainMap<string>,
): Promise<ChainMap<Address>> {
  assertWarpConfigTimelocksSupportedByProtocols({
    multiProvider,
    warpDeployConfig,
  });
  WarpRouteDeployConfigMailboxRequiredSchema.parse(warpDeployConfig);
  const args: WarpDeployArgs = {
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    apiKeys,
  };
  const hybridPlan = planWarpRouteHybrids({ multiProvider, warpDeployConfig });
  assertDelayedFlowRouteCoverage({ multiProvider, warpDeployConfig });
  await assertDelayedFlowMailboxNonces(multiProvider, warpDeployConfig);
  return deployWarpRouteChains(args, hybridPlan);
}

/**
 * Deploys the chains an extension adds to an EXISTING route.
 *
 * Same engine as `executeWarpDeploy`, minus the invariants that measure the
 * route by the config's own chain set — the caller holds the full route config
 * and has already checked those (runWarpRouteApply). Everything per chain still
 * runs here, so an extension cannot deploy a chain whose composition can never
 * work.
 *
 * A separate entry point rather than a flag: which validation applies is a
 * property of what the caller is deploying, not something to infer from the
 * shape of the config it happens to pass.
 */
export async function executeWarpRouteExtensionDeploy(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  registryAddresses: ChainMap<ChainAddresses>,
  apiKeys: ChainMap<string>,
): Promise<ChainMap<Address>> {
  assertWarpConfigTimelocksSupportedByProtocols({
    multiProvider,
    warpDeployConfig,
  });
  WarpRouteDeployConfigMailboxRequiredSchema.parse(warpDeployConfig);
  const args: WarpDeployArgs = {
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    apiKeys,
  };
  const hybridPlan = planWarpRouteHybrids({ multiProvider, warpDeployConfig });
  assertDelayedFlowLegCoverage(warpDeployConfig);
  await assertDelayedFlowMailboxNonces(multiProvider, warpDeployConfig);
  return deployWarpRouteChains(args, hybridPlan);
}

/**
 * The staged deploy engine shared by both entry points. Called only after the
 * whole config has been parsed and validated, so nothing here re-decides
 * whether the route is deployable — it just deploys it in an order that never
 * leaves an unsafe route reachable:
 *
 * 1. routers are deployed BARE on every chain that installs a hybrid: the
 *    hybrid constructors read the live router's `token()` / `mailbox()`, so the
 *    router has to exist first, and it must not be usable in the meantime;
 * 2. the hybrid leaf is deployed exactly once per chain and bound to that
 *    router;
 * 3. DELAYED_FLOW_ROUTER counterparts are enrolled once every chain's instance
 *    address is known, while the deployer still owns the fresh instances;
 * 4. the leaf address replaces the hybrid node in BOTH trees, and the remaining
 *    parents are deployed through the ordinary modules;
 * 5. hooks are installed route-wide, then read back, and only then are the ISMs
 *    installed — a router whose hybrid ISM is live before its hook is one that
 *    rejects every delivery, because nothing sent the preverification.
 *
 * Router enrollment and ownership transfer happen after this returns
 * (enrollCrossChainRouters), so no transfer can be dispatched through a
 * half-wired router.
 */
async function deployWarpRouteChains(
  {
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    apiKeys,
  }: WarpDeployArgs,
  hybridPlan: WarpHybridPlan,
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

  // RATE_LIMITED ISM trees are deployed after the router exists: the
  // constructor takes the token as `recipient`. Unlike the hybrids they are
  // only an ISM, so TokenDeployer wires them itself, before it hands ownership
  // over.
  const rateLimitedIsmSnapshot: ChainMap<IsmConfig> = {};
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    // Hybrid chains deploy the whole resolved parent tree in the staged pass;
    // passing the same tree to TokenDeployer would deploy it a second time.
    if (hybridPlan[chain]) continue;
    if (typeof config.interchainSecurityModule !== 'object') continue;
    const ism = config.interchainSecurityModule;
    if (!ismTreeContainsRateLimited(ism)) continue;
    const protocol = multiProvider.getProtocol(chain);
    assert(
      protocol === ProtocolType.Ethereum || protocol === ProtocolType.Tron,
      `${IsmType.RATE_LIMITED} is only supported on Ethereum and Tron chains, but chain ${chain} has protocol ${protocol}`,
    );
    rateLimitedIsmSnapshot[chain] = ism;
  }

  // Hooks containing RATE_LIMITED need the token router address as sender, so they are deferred
  // until after token deployment. resolveWarpIsmAndHook populates this map (EVM/Tron only) and
  // returns undefined for those hooks, causing them to be set later via setHook().
  const rateLimitedHookSnapshots: ChainMap<RateLimitedHookDeployInput> = {};

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism and/or hook address as a string.
  // Chains that install a hybrid get NEITHER surface here: their router is
  // deployed bare and wired in the staged pass below.
  const modifiedConfig = await resolveWarpIsmAndHook(
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    ismFactoryDeployer,
    contractVerifier,
    rateLimitedHookSnapshots,
    hybridPlan,
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
                  // The deployed address is deliberately NOT written back into
                  // warpDeployConfig: the caller persists that object to the
                  // registry, which stores declarative config, not the runtime
                  // addresses of this run.
                  await deployAndWireRateLimitedHooks(
                    chainSnapshots,
                    deployedTokens,
                    multiProvider,
                    contractVerifier,
                  );
                },
              );

        const chainSet = new Set(Object.keys(protocolSpecificConfig));
        const deferredForBatch = objFilter(
          rateLimitedIsmSnapshot,
          (_chain, _ismConfig): _ismConfig is IsmConfig => chainSet.has(_chain),
        );
        // Deploy as the deployer signer (intermediate owner), mirroring the
        // AltVM branch below. Cross-chain router enrollment runs after deploy
        // in enrollCrossChainRouters, submitted by the deployer key, and hands
        // ownership to the configured owner. If deploy set the configured owner
        // up front, the deployer could no longer sign those post-deploy
        // enrollment txs. Only the top-level router owner is overridden; ISM and
        // hook owners come from their own config sub-trees and are unaffected.
        const intermediateOwnerConfig = await promiseObjAll(
          objMap(protocolSpecificConfig, async (chain, config) => ({
            ...config,
            // ALRBs have no post-deploy router enrollment. Preserve their
            // configured owner here so TokenDeployer can deploy with the
            // signer as the constructor owner and then perform the final
            // ownership transfer before returning.
            owner:
              config.type === TokenType.atomicLocalRebalancing
                ? config.owner
                : await multiProvider.getSigner(chain).getAddress(),
          })),
        );
        const deferRouterEnrollment = Object.keys(protocolSpecificConfig).some(
          (chain) => chain in hybridPlan,
        );
        const evmContracts = warpDeployConfig.isNft
          ? await deployer.deploy(intermediateOwnerConfig)
          : await deployer.deploy(intermediateOwnerConfig, deferredForBatch, {
              deferRouterEnrollment,
            });
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

          // Deploy as the signer (intermediate owner), mirroring the EVM
          // deployer (see TokenDeployer.deploy). Cross-chain router enrollment
          // runs after deploy in enrollCrossChainRouters, submitted by the
          // deployer key; it also hands ownership to the configured owner. If
          // create() set the configured owner up front, the deployer could no
          // longer sign those post-deploy enrollment txs.
          const intermediateOwnerConfig = {
            ...config,
            owner: signer.getSignerAddress(),
          };

          const artifact = warpConfigToArtifact(
            validateWarpConfigForAltVM(
              intermediateOwnerConfig,
              chain,
              chainMetadata.protocol,
            ),
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

  await wireHybridHookIsms({
    hybridPlan,
    multiProvider,
    registryAddresses,
    contractVerifier,
    warpDeployConfig,
    deployedContracts,
  });

  return deployedContracts;
}

/** The addresses one chain's hybrid composition resolves to. */
type HybridWiring = {
  router: Address;
  /** The shared instance, installed as both the hook and (inside the tree) the ISM. */
  hybrid: Address;
  /** Root of the ISM tree to install on the router. */
  ism: Address;
  /** Root of the hook tree to install on the router. */
  hook: Address;
};

/**
 * Stages 2 to 5 of the deploy: turn bare routers into fully wired hybrid legs.
 *
 * Split out of the protocol loop above because every stage is a route-wide
 * barrier — stage N must have completed on EVERY chain before stage N+1 starts
 * on ANY of them. Enrollment needs all instance addresses; the hook install
 * needs every counterpart enrolled; the ISM install needs every hook live.
 */
async function wireHybridHookIsms({
  hybridPlan,
  multiProvider,
  registryAddresses,
  contractVerifier,
  warpDeployConfig,
  deployedContracts,
}: {
  hybridPlan: WarpHybridPlan;
  multiProvider: MultiProvider;
  registryAddresses: ChainMap<ChainAddresses>;
  contractVerifier: ContractVerifier;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  deployedContracts: ChainMap<Address>;
}): Promise<void> {
  if (isObjEmpty(hybridPlan)) return;

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    registryAddresses,
    multiProvider,
    undefined,
    contractVerifier,
  );

  // Stage 2 — one instance per chain, bound to the router deployed above.
  // deployInternal rather than deploy: the leaf on its own is exactly the shape
  // IsmConfigSchema rejects (a hybrid outside its mandatory aggregation), and
  // the composition it would re-check was already validated over the whole tree
  // by planWarpRouteHybrids.
  const hybridAddresses = await promiseObjAll(
    objMap(hybridPlan, async (chain, entry) => {
      const router = mustGet(deployedContracts, chain);
      const chainAddresses = mustGet(registryAddresses, chain);
      const leaf = hybridLeafDeployConfig({
        entry,
        warpRouter: router,
        deployerAddress: await multiProvider.getSigner(chain).getAddress(),
      });
      rootLogger.info(
        `Deploying ${leaf.type} on ${chain} for router ${router}`,
      );
      const deployed = await ismFactory.deployInternal({
        destination: chain,
        config: leaf,
        mailbox: chainAddresses.mailbox,
      });
      return deployed.address;
    }),
  );

  // Stage 3 — pair the DELAYED_FLOW_ROUTER instances with each other while the
  // deployer still owns them. Ownership moves to the configured owner in the
  // route's final pass (enrollCrossChainRouters), which is also what re-runs
  // this reconciliation for a route that was only partly enrolled.
  await enrollDelayedFlowInstances({
    hybridPlan,
    multiProvider,
    hybridAddresses,
  });

  // Stage 4 — substitute the shared address into both trees and deploy whatever
  // parents remain through the ordinary modules.
  const wiring = await promiseObjAll(
    objMap(hybridPlan, async (chain, entry): Promise<HybridWiring> => {
      const hybrid = mustGet(hybridAddresses, chain);
      const router = mustGet(deployedContracts, chain);
      const chainAddresses = mustGet(registryAddresses, chain);
      const resolved = resolveHybridTrees(entry, hybrid);
      const resolvedIsm = setRateLimitedIsmRecipient(
        resolved.ism,
        router,
        mustGet(warpDeployConfig, chain).owner,
      );
      const ccipContractCache = new CCIPContractCache(registryAddresses);
      const proxyFactoryFactories =
        extractIsmAndHookFactoryAddresses(chainAddresses);

      const ism =
        typeof resolvedIsm === 'string'
          ? resolvedIsm
          : await deployIsmTree({
              chain,
              multiProvider,
              chainAddresses,
              config: resolvedIsm,
              ccipContractCache,
              contractVerifier,
              proxyFactoryFactories,
            });

      const hook =
        typeof resolved.hook === 'string'
          ? resolved.hook
          : await deployHookTree({
              chain,
              multiProvider,
              chainAddresses,
              config: resolved.hook,
              ccipContractCache,
              contractVerifier,
              proxyFactoryFactories,
              proxyAdminAddress: mustGet(warpDeployConfig, chain).proxyAdmin
                ?.address,
            });

      return { router, hybrid, ism, hook };
    }),
  );

  // Stage 5 — hooks route-wide, barrier, then ISMs route-wide.
  await installHybridSurfaces({ multiProvider, wiring });
}

async function deployIsmTree({
  chain,
  multiProvider,
  chainAddresses,
  config,
  ccipContractCache,
  contractVerifier,
  proxyFactoryFactories,
}: {
  chain: ChainName;
  multiProvider: MultiProvider;
  chainAddresses: ChainAddresses;
  config: IsmConfig;
  ccipContractCache: CCIPContractCache;
  contractVerifier: ContractVerifier;
  proxyFactoryFactories: ReturnType<typeof extractIsmAndHookFactoryAddresses>;
}): Promise<Address> {
  const module = await EvmIsmModule.create({
    chain,
    mailbox: chainAddresses.mailbox,
    multiProvider,
    proxyFactoryFactories,
    config,
    ccipContractCache,
    contractVerifier,
  });
  const { deployedIsm } = module.serialize();
  assert(deployedIsm, `Failed to deploy the ISM tree on ${chain}`);
  return deployedIsm;
}

async function deployHookTree({
  chain,
  multiProvider,
  chainAddresses,
  config,
  ccipContractCache,
  contractVerifier,
  proxyFactoryFactories,
  proxyAdminAddress,
}: {
  chain: ChainName;
  multiProvider: MultiProvider;
  chainAddresses: ChainAddresses;
  config: HookConfig;
  ccipContractCache: CCIPContractCache;
  contractVerifier: ContractVerifier;
  proxyFactoryFactories: ReturnType<typeof extractIsmAndHookFactoryAddresses>;
  proxyAdminAddress: Address | undefined;
}): Promise<Address> {
  const resolvedProxyAdmin =
    proxyAdminAddress ??
    (await multiProvider.handleDeploy(chain, new ProxyAdmin__factory(), []))
      .address;
  const module = await EvmHookModule.create({
    chain,
    multiProvider,
    coreAddresses: {
      mailbox: chainAddresses.mailbox,
      proxyAdmin: resolvedProxyAdmin,
    },
    config,
    ccipContractCache,
    contractVerifier,
    proxyFactoryFactories,
  });
  const { deployedHook } = module.serialize();
  assert(deployedHook, `Failed to deploy the hook tree on ${chain}`);
  return deployedHook;
}

/**
 * Enrolls every DELAYED_FLOW_ROUTER instance of the route with every other one.
 *
 * Runs once all instance addresses exist and while the deployer still owns them
 * (`hybridLeafDeployConfig` keeps DFR ownership with the deployer for exactly
 * this reason), so a fresh route needs no owner-gated batch. Route-derived
 * peers override configured entries for the same chains; configured external
 * peers remain available for unusual topologies.
 */
async function enrollDelayedFlowInstances({
  hybridPlan,
  multiProvider,
  hybridAddresses,
}: {
  hybridPlan: WarpHybridPlan;
  multiProvider: MultiProvider;
  hybridAddresses: ChainMap<Address>;
}): Promise<void> {
  const delayedChains = Object.keys(hybridPlan).filter(
    (chain) => hybridPlan[chain].node.type === IsmType.DELAYED_FLOW_ROUTER,
  );
  if (delayedChains.length === 0) return;

  await Promise.all(
    delayedChains.map(async (chain) => {
      const node = hybridPlan[chain].node;
      assert(
        node.type === IsmType.DELAYED_FLOW_ROUTER,
        `Unreachable: ${chain} was filtered as a delayed-flow chain`,
      );
      const ismAddress = mustGet(hybridAddresses, chain);
      const derived = Object.fromEntries(
        delayedChains
          .filter((otherChain) => otherChain !== chain)
          .map((otherChain) => [
            otherChain,
            addressToBytes32(mustGet(hybridAddresses, otherChain)),
          ]),
      );
      const remoteIsms = resolveDelayedFlowRemoteIsms(
        node.remoteIsms,
        derived,
        `${IsmType.DELAYED_FLOW_ROUTER} ${ismAddress} on ${chain}`,
        multiProvider,
      );
      if (!remoteIsms || isObjEmpty(remoteIsms)) return;

      const domains: number[] = [];
      const routers: string[] = [];
      for (const [remoteChain, router] of Object.entries(remoteIsms)) {
        domains.push(multiProvider.getDomainId(remoteChain));
        routers.push(router);
      }
      rootLogger.info(
        `Enrolling ${domains.length} counterpart(s) on ${IsmType.DELAYED_FLOW_ROUTER} ${ismAddress} (${chain})`,
      );
      const instance = DelayedFlowRouterHookIsm__factory.connect(
        ismAddress,
        multiProvider.getSigner(chain),
      );
      await multiProvider.handleTx(
        chain,
        instance.enrollRemoteRouters(
          domains,
          routers,
          multiProvider.getTransactionOverrides(chain),
        ),
      );
    }),
  );
}

/** Installs hooks route-wide before installing the corresponding ISMs. */
async function installHybridSurfaces({
  multiProvider,
  wiring,
}: {
  multiProvider: MultiProvider;
  wiring: ChainMap<HybridWiring>;
}): Promise<void> {
  await promiseObjAll(
    objMap(wiring, async (chain, { router, hook }) => {
      rootLogger.info(`Installing hook ${hook} on router ${router} (${chain})`);
      await multiProvider.sendTransaction(chain, {
        to: router,
        data: MailboxClient__factory.createInterface().encodeFunctionData(
          'setHook',
          [hook],
        ),
      });
    }),
  );

  await promiseObjAll(
    objMap(wiring, async (chain, { router, ism }) => {
      rootLogger.info(`Installing ISM ${ism} on router ${router} (${chain})`);
      await multiProvider.sendTransaction(chain, {
        to: router,
        data: MailboxClient__factory.createInterface().encodeFunctionData(
          'setInterchainSecurityModule',
          [ism],
        ),
      });
    }),
  );
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
  hybridPlan: WarpHybridPlan,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      const ccipContractCache = new CCIPContractCache(registryAddresses);
      const chainAddresses = registryAddresses[chain];

      if (!chainAddresses) {
        throw new Error(`Registry factory addresses not found for ${chain}.`);
      }

      // A chain whose composition includes a hybrid deploys its router BARE.
      // Both surfaces reference one instance whose constructor reads the live
      // router, so neither tree can be built yet — and leaving the router
      // without an ISM or hook until both are ready is what keeps a
      // half-wired route from being usable.
      if (hybridPlan[chain]) {
        rootLogger.info(
          `Deploying ${chain} router bare: its ${hybridPlan[chain].node.type} is wired after the router exists`,
        );
        return {
          ...config,
          interchainSecurityModule: undefined,
          hook: undefined,
        };
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

  // A RATE_LIMITED ISM has a chicken-and-egg problem: its constructor requires
  // the token address as `recipient`, but ISMs are deployed here — before the
  // token exists. Skip any tree containing one; TokenDeployer.setRateLimitedIsms
  // deploys it after the router and wires it with setInterchainSecurityModule()
  // while the deployer still owns the router. (Hybrid hook/ISM trees never
  // reach this function — resolveWarpIsmAndHook returns their chains bare.)
  if (ismTreeContainsRateLimited(interchainSecurityModule)) {
    rootLogger.info(
      `Skipping ISM deployment for ${chain} (contains a ${IsmType.RATE_LIMITED} ISM), will deploy after token.`,
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

export type DelayedFlowEnrollmentTarget = {
  ismAddress: Address;
  userNode: DelayedFlowRouterHookIsmConfig;
};

/**
 * The DELAYED_FLOW_ROUTER nodes a chain's warp config installs.
 *
 * An ISM configured as a bare address cannot be inspected, so it reads as "no
 * instance"; assertDelayedFlowLegCoverage turns that into an explicit error
 * instead of a silent pass.
 */
function delayedFlowIsmNodes(
  config: WarpRouteDeployConfigMailboxRequired[string],
): DelayedFlowRouterHookIsmConfig[] {
  if (typeof config.interchainSecurityModule !== 'object') return [];
  return collectHybridIsmNodes(config.interchainSecurityModule).filter(
    (node): node is DelayedFlowRouterHookIsmConfig =>
      node.type === IsmType.DELAYED_FLOW_ROUTER,
  );
}

/** True when a chain's warp config installs a DELAYED_FLOW_ROUTER instance. */
function configInstallsDelayedFlowIsm(
  config: WarpRouteDeployConfigMailboxRequired[string],
): boolean {
  return delayedFlowIsmNodes(config).length > 0;
}

/** The chains of a config whose ISM tree installs a DELAYED_FLOW_ROUTER. */
function delayedFlowChains(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
): ChainName[] {
  return Object.keys(warpDeployConfig).filter((chain) =>
    configInstallsDelayedFlowIsm(warpDeployConfig[chain]),
  );
}

/** Domain id of every chain the route deploys, asserted resolvable. */
function resolveRouteDomains(
  multiProvider: MultiProvider,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
): Map<ChainName, number> {
  const routeDomains = new Map<ChainName, number>();
  for (const chain of Object.keys(warpDeployConfig)) {
    const domain = multiProvider.tryGetDomainId(chain);
    assert(
      domain !== null,
      `No chain metadata for ${chain}, which this ${IsmType.DELAYED_FLOW_ROUTER} route deploys — add it to the registry`,
    );
    routeDomains.set(chain, domain);
  }
  return routeDomains;
}

/**
 * The domains a chain's DELAYED_FLOW_ROUTER nodes enroll through `remoteIsms`.
 *
 * Resolved through the same canonicalization the deploy, update and check
 * paths use (canonicalizeRemoteIsms), so this preflight accepts exactly the
 * keys they accept: a key it cannot resolve, or two keys naming one chain,
 * throw here — before any contract is deployed — instead of passing the
 * preflight and failing mid-deploy.
 */
function configuredRemoteIsmDomains(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: WarpRouteDeployConfigMailboxRequired[string],
): Set<number> {
  const domains = new Set<number>();
  for (const node of delayedFlowIsmNodes(config)) {
    const canonical = canonicalizeRemoteIsms(
      node.remoteIsms ?? {},
      multiProvider,
      `${IsmType.DELAYED_FLOW_ROUTER} on ${chain}`,
    );
    for (const chainName of Object.keys(canonical)) {
      domains.add(multiProvider.getDomainId(chainName));
    }
  }
  return domains;
}

/**
 * Rejects a `remoteRouters` entry naming a chain outside the deploy config
 * unless the chain's DelayedFlowRouterHookIsm enrolls it through `remoteIsms`.
 *
 * `remoteRouters` legs are as connected as the deployed ones:
 * `TimelockRouter.postDispatch` dispatches the preverification to the
 * transfer's destination domain, and `Router._mustHaveRemoteRouter` reverts
 * when the instance has no counterpart enrolled there. The automatic pairing
 * only covers the chains of the deploy config (deriveDelayedFlowEnrollmentTargets),
 * so an out-of-config leg strands transfers exactly like an uncovered one.
 *
 * `remoteIsms` is the escape hatch for pairings the route cannot derive. The
 * route-derived peers are merged into it separately.
 */
function assertDelayedFlowRemoteRouterCoverage(
  multiProvider: MultiProvider,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  routeDomains: Map<ChainName, number>,
): void {
  const deployedDomains = new Set<number>(routeDomains.values());

  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    const enrolledDomains = configuredRemoteIsmDomains(
      multiProvider,
      chain,
      config,
    );

    for (const key of Object.keys(config.remoteRouters ?? {})) {
      // Resolved through the registry for BOTH key forms (chain name and
      // domain id): the only remedy this check can suggest for an unenrolled
      // domain is listing it under 'remoteIsms', and canonicalizeRemoteIsms
      // rejects a key it cannot resolve to a registered chain. Taking a
      // numeric key at face value here would send the operator round in a
      // circle between the two checks.
      const domain = multiProvider.tryGetDomainId(key);
      assert(
        domain !== null,
        `No chain metadata for ${key}, which ${chain} names in 'remoteRouters' — this route's ${IsmType.DELAYED_FLOW_ROUTER} legs are resolved through the registry, so add the chain to it or remove the entry`,
      );
      const remoteName = multiProvider.getChainName(domain);
      assert(
        deployedDomains.has(domain) || enrolledDomains.has(domain),
        `${chain} names ${remoteName} (domain ${domain}) in 'remoteRouters', but that chain is not part of this route and ${chain}'s ${IsmType.DELAYED_FLOW_ROUTER} does not enroll it. Transfers to it dispatch a preverification through that instance, which reverts because no counterpart is enrolled for the domain. Add ${remoteName} to the route, drop it from 'remoteRouters', or list its ${IsmType.DELAYED_FLOW_ROUTER} instance under 'remoteIsms' on ${chain}.`,
      );
    }
  }
}

/**
 * Rejects a config that carries a DelayedFlowRouterHookIsm on only some of its
 * legs, before any on-chain work happens.
 *
 * The instances are peers: `TimelockRouter.postDispatch` dispatches a
 * preverification message to the transfer's destination domain, and
 * `Router._mustHaveRemoteRouter` reverts when that domain has no counterpart
 * enrolled. So a DFR origin paired with a plain destination reverts at
 * quote/dispatch time, and a plain origin paired with a DFR destination never
 * sends the preverification the destination waits for — the transfer is
 * stranded either way. A foreignDeployment leg is rejected outright: its
 * instance is outside this deployment's control, so it can never be enrolled.
 *
 * Safe on any subset of a route: dropping a chain drops it from both sides of
 * every comparison here, so a topology accepted as a whole is still accepted
 * chain by chain. The checks whose verdict depends on WHICH chains the config
 * contains live in assertDelayedFlowRouteCoverage.
 *
 * Checked against the config rather than mid-apply on purpose: an extension
 * applies chain by chain, so a mid-apply check would fire on a route that is
 * merely part-deployed.
 */
function assertDelayedFlowLegCoverage(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
): void {
  const chains = Object.keys(warpDeployConfig);
  const covered = delayedFlowChains(warpDeployConfig);
  if (covered.length === 0) return;

  const foreignDeployments = chains.filter(
    (chain) => !!warpDeployConfig[chain].foreignDeployment,
  );
  assert(
    foreignDeployments.length === 0,
    `${IsmType.DELAYED_FLOW_ROUTER} is configured on ${covered.join(', ')}, but ${foreignDeployments.join(', ')} is a foreignDeployment whose instance cannot be deployed or enrolled by this route. Every leg of a delayed-flow route must be deployed by it.`,
  );

  const uncovered = chains.filter(
    (chain) => !configInstallsDelayedFlowIsm(warpDeployConfig[chain]),
  );
  assert(
    uncovered.length === 0,
    `${IsmType.DELAYED_FLOW_ROUTER} is configured on ${covered.join(', ')} but not on ${uncovered.join(', ')}. Transfers between a delayed-flow leg and a plain leg revert on both sides, so every chain of the route must configure one (an ISM given as an address cannot be inspected — declare it inline).`,
  );
}

/**
 * Whole-route coverage: every leg carries an instance
 * (assertDelayedFlowLegCoverage), and a `remoteRouters` entry naming a chain
 * outside the route has to enroll that counterpart explicitly
 * (assertDelayedFlowRemoteRouterCoverage).
 *
 * Correct only against the FULL route config. Shrinking the config enlarges
 * what counts as outside the route, so running this on a subset — the single
 * chain `warp apply` deploys per extension, say — rejects `remoteRouters`
 * entries naming the very legs that chain is joining.
 */
export function assertDelayedFlowRouteCoverage({
  multiProvider,
  warpDeployConfig,
}: {
  multiProvider: MultiProvider;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}): void {
  assertDelayedFlowLegCoverage(warpDeployConfig);
  if (delayedFlowChains(warpDeployConfig).length === 0) return;

  const routeDomains = resolveRouteDomains(multiProvider, warpDeployConfig);
  assertDelayedFlowRemoteRouterCoverage(
    multiProvider,
    warpDeployConfig,
    routeDomains,
  );
}

/**
 * Rejects a delayed-flow leg whose mailbox has never dispatched a message.
 *
 * DelayedFlowRouterHookIsm initialises `lastCreditedNonce` to 0 and rejects
 * `nonce <= lastCreditedNonce`, so a dispatch carrying mailbox nonce 0 can
 * never be credited: the first transfer out of a brand-new mailbox reverts
 * inside postDispatch and the route strands it. Deploying onto such a chain is
 * rejected instead of producing a route whose first transfer is guaranteed to
 * fail. Per chain, so it holds on any subset of a route.
 */
async function assertDelayedFlowMailboxNonces(
  multiProvider: MultiProvider,
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
): Promise<void> {
  const mailboxNonces = await Promise.all(
    delayedFlowChains(warpDeployConfig).map(async (chain) => {
      const protocol = multiProvider.getProtocol(chain);
      assert(
        protocol === ProtocolType.Ethereum || protocol === ProtocolType.Tron,
        `${IsmType.DELAYED_FLOW_ROUTER} is configured on ${chain}, whose protocol is ${protocol} — the contract only exists on Ethereum and Tron chains`,
      );
      const { mailbox } = warpDeployConfig[chain];
      assert(mailbox, `Missing mailbox address for ${chain}`);
      const nonce = await Mailbox__factory.connect(
        mailbox,
        multiProvider.getProvider(chain),
      ).nonce();
      return { chain, mailbox, nonce };
    }),
  );

  for (const { chain, mailbox, nonce } of mailboxNonces) {
    assert(
      nonce > 0,
      `Mailbox ${mailbox} on ${chain} has never dispatched a message, and ${IsmType.DELAYED_FLOW_ROUTER} cannot credit a dispatch carrying mailbox nonce 0 (its lastCreditedNonce starts at 0 and it rejects nonce <= lastCreditedNonce), so the route's first transfer out of ${chain} would revert. Dispatch any other message through that mailbox first.`,
    );
  }
}

/**
 * The full delayed-flow preconditions for a whole route, checked before any
 * on-chain work: assertDelayedFlowRouteCoverage — which adds the route-scoped
 * external `remoteRouters` check to the leg coverage above — and the
 * mailbox nonce guard.
 *
 * Call this with every chain of the route. The CLI entry points do
 * (runWarpRouteDeploy, runWarpRouteApply); executeWarpDeploy cannot, because
 * an extension reaches it one chain at a time.
 */
export async function assertDelayedFlowRoutePreconditions({
  multiProvider,
  warpDeployConfig,
}: {
  multiProvider: MultiProvider;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}): Promise<void> {
  assertDelayedFlowRouteCoverage({ multiProvider, warpDeployConfig });
  await assertDelayedFlowMailboxNonces(multiProvider, warpDeployConfig);
}

/**
 * The hybrid hook/ISM instance nested inside an ISM tree deployed on chain, or
 * undefined when the tree holds none.
 *
 * The ISM surface is where the instance is always reachable: the hook surface
 * may install an aggregation the instance merely sits inside, whereas the ISM
 * tree is what the schema constrains and what `EvmIsmReader` walks, and derived
 * nodes carry their address.
 */
async function readHybridIsmInTree(
  multiProvider: MultiProvider,
  chain: ChainName,
  ismTreeAddress: Address,
): Promise<Address | undefined> {
  if (isZeroishAddress(ismTreeAddress)) return undefined;
  const derived = await new EvmIsmReader(multiProvider, chain).deriveIsmConfig(
    ismTreeAddress,
  );
  const nodes = collectHybridIsmNodes(derived);
  if (nodes.length === 0) return undefined;
  assert(
    nodes.length === 1,
    `Expected at most one hybrid hook/ISM instance in the ISM tree at ${ismTreeAddress} on ${chain}, found ${nodes.length}`,
  );
  const node = nodes[0];
  assert(
    'address' in node && typeof node.address === 'string',
    `Derived hybrid hook/ISM node on ${chain} is missing its address`,
  );
  return node.address;
}

/**
 * Resolves the shared hybrid instance behind each chain's ISM tree.
 *
 * Callers pass whichever tree is authoritative for them: the address a run has
 * just deployed but not yet installed, or the tree already on the router.
 * Nothing here guesses between the two — a caller that knows both states knows
 * which one it means.
 */
export async function resolveHybridIsmAddresses(
  multiProvider: MultiProvider,
  ismTreeAddresses: ChainMap<Address>,
): Promise<ChainMap<Address>> {
  const resolved: ChainMap<Address> = {};
  await Promise.all(
    Object.entries(ismTreeAddresses).map(async ([chain, treeAddress]) => {
      const hybrid = await readHybridIsmInTree(
        multiProvider,
        chain,
        treeAddress,
      );
      if (hybrid) resolved[chain] = hybrid;
    }),
  );
  return resolved;
}

/**
 * Resolves the hybrid instance installed on each router, by reading the ISM the
 * router currently points at. Used by callers holding only routers, such as
 * `warp apply` on chains it is not re-deploying.
 */
export async function readInstalledHybridIsmAddresses(
  multiProvider: MultiProvider,
  routers: ChainMap<Address>,
): Promise<ChainMap<Address>> {
  const ismTrees: ChainMap<Address> = {};
  await Promise.all(
    Object.entries(routers).map(async ([chain, router]) => {
      const protocol = multiProvider.getProtocol(chain);
      if (
        protocol !== ProtocolType.Ethereum &&
        protocol !== ProtocolType.Tron
      ) {
        return;
      }
      ismTrees[chain] = await MailboxClient__factory.connect(
        router,
        multiProvider.getProvider(chain),
      ).interchainSecurityModule();
    }),
  );
  return resolveHybridIsmAddresses(multiProvider, ismTrees);
}

/**
 * Pairs the route's DelayedFlowRouterHookIsm instances so each one's enrollment
 * transactions can name every other one.
 *
 * `hybridIsmAddresses` is supplied by the caller (resolveHybridIsmAddresses /
 * readInstalledHybridIsmAddresses) rather than re-derived here: which tree is
 * authoritative differs per caller, and a chain whose instance the caller could
 * not resolve is skipped rather than silently paired against a stale one. The
 * config node is carried through as `userNode` so configured external
 * `remoteIsms` are merged with the route-derived pairing.
 */
export async function deriveDelayedFlowEnrollmentTargets(
  multiProvider: MultiProvider,
  // Mailbox-independent: the pairing is read from the instances themselves, so
  // callers that only hold a registry deploy config can use it too.
  warpDeployConfig: WarpRouteDeployConfig,
  deployedContracts: ChainMap<Address>,
  hybridIsmAddresses?: ChainMap<Address>,
): Promise<ChainMap<DelayedFlowEnrollmentTarget>> {
  const resolvedHybridAddresses =
    hybridIsmAddresses ??
    (await readInstalledHybridIsmAddresses(multiProvider, deployedContracts));
  const targets: ChainMap<DelayedFlowEnrollmentTarget> = {};
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    if (config.foreignDeployment) continue;
    if (typeof config.interchainSecurityModule !== 'object') continue;
    const protocol = multiProvider.getProtocol(chain);
    if (protocol !== ProtocolType.Ethereum && protocol !== ProtocolType.Tron) {
      continue;
    }

    const delayedNodes = collectHybridIsmNodes(
      config.interchainSecurityModule,
    ).filter(
      (node): node is DelayedFlowRouterHookIsmConfig =>
        node.type === IsmType.DELAYED_FLOW_ROUTER,
    );
    if (delayedNodes.length === 0) continue;
    assert(
      delayedNodes.length === 1,
      `Expected exactly one DELAYED_FLOW_ROUTER node in the ISM tree on ${chain}, found ${delayedNodes.length}`,
    );

    const tokenAddress = deployedContracts[chain];
    assert(tokenAddress, `No deployed token found for ${chain}`);
    const provider = multiProvider.getProvider(chain);
    const ismAddress = resolvedHybridAddresses[chain];
    assert(
      ismAddress,
      `${chain} declares a ${IsmType.DELAYED_FLOW_ROUTER} but no instance was resolved for it — the instance must be deployed and reachable through the router's ISM tree before its remote counterparts can be enrolled`,
    );

    const instance = DelayedFlowRouterHookIsm__factory.connect(
      ismAddress,
      provider,
    );

    // maxDelay() is what identifies the contract: NetFlowRateLimitedHookIsm
    // exposes warpRouter() too, so probing that alone would return a NetFlow
    // instance as a DELAYED_FLOW_ROUTER enrollment target and pair the wrong
    // contract. Only DelayedFlowRouterHookIsm declares maxDelay (a uint48
    // immutable), the same discriminator EvmIsmReader and EvmHookReader use,
    // and it returns a value, so a contract missing the selector reverts
    // instead of decoding empty returndata as a match.
    //
    // The router's current hook is only a DelayedFlowRouterHookIsm once the
    // hybrid has been wired; on an older route it can be another hook or the
    // zero address, and these getters would then revert inside the provider
    // with a raw call exception instead of reaching the asserts below.
    let onChainMaxDelay: number | undefined;
    try {
      onChainMaxDelay = await instance.maxDelay();
    } catch (error) {
      throwIfNotMissingSelector(error);
    }
    assert(
      onChainMaxDelay !== undefined,
      `Contract ${ismAddress} on ${chain} does not expose maxDelay(), so it is not a DelayedFlowRouterHookIsm — resolve the instance from the ISM tree the router actually installs`,
    );

    let onChainWarpRouter: Address | undefined;
    try {
      onChainWarpRouter = await instance.warpRouter();
    } catch (error) {
      throwIfNotMissingSelector(error);
    }
    assert(
      onChainWarpRouter !== undefined,
      `Contract ${ismAddress} on ${chain} does not expose warpRouter(), so it is not the token's DelayedFlowRouterHookIsm — resolve the instance from the ISM tree the router actually installs`,
    );
    assert(
      eqAddress(onChainWarpRouter, tokenAddress),
      `Contract ${ismAddress} on ${chain} is not the token's DelayedFlowRouterHookIsm (warpRouter mismatch)`,
    );

    targets[chain] = { ismAddress, userNode: delayedNodes[0] };
  }
  return targets;
}

/**
 * Builds the enrollment transactions for one chain's
 * DelayedFlowRouterHookIsm: enrolls every other chain's instance as a remote
 * counterpart, plus configured peers outside the route, and
 * optionally transfers ownership to the configured owner LAST (the enrollment
 * calls are owner-gated). Converges to zero transactions once the on-chain
 * state already matches.
 *
 * Shared by the deploy flow (deployer-owned instances) and `warp apply`
 * (instances that may be owned by a Safe/ICA — the returned transactions carry
 * no signing assumptions and ride whichever submitter the caller uses).
 */
export async function buildDelayedFlowEnrollmentTxs({
  chain,
  multiProvider,
  registryAddresses,
  warpRouter,
  target,
  allTargets,
  reconcileOwnership = true,
}: {
  chain: ChainName;
  multiProvider: MultiProvider;
  registryAddresses: ChainMap<ChainAddresses>;
  warpRouter: Address;
  target: DelayedFlowEnrollmentTarget;
  allTargets: ChainMap<DelayedFlowEnrollmentTarget>;
  /** Preserve the current owner when ownership is handled by another phase. */
  reconcileOwnership?: boolean;
}): Promise<AnnotatedEV5Transaction[]> {
  const { ismAddress, userNode } = target;
  const derivedRemoteIsms = Object.fromEntries(
    Object.entries(allTargets)
      .filter(([otherChain]) => otherChain !== chain)
      .map(([otherChain, otherTarget]) => [
        otherChain,
        addressToBytes32(otherTarget.ismAddress).toLowerCase(),
      ]),
  );
  // Same resolution expandWarpDeployConfig applies to the expected config, so
  // `warp check` compares exactly the enrollment installed here.
  const remoteIsms = resolveDelayedFlowRemoteIsms(
    userNode.remoteIsms,
    derivedRemoteIsms,
    `DelayedFlowRouterHookIsm ${ismAddress} on ${chain}`,
    multiProvider,
  );

  const delayedFlowIsmModule = new EvmIsmModule(multiProvider, {
    chain,
    config: userNode,
    addresses: {
      ...extractIsmAndHookFactoryAddresses(registryAddresses[chain]),
      mailbox: registryAddresses[chain].mailbox,
      deployedIsm: ismAddress,
    },
  });

  const current = await delayedFlowIsmModule.read();
  assert(
    typeof current === 'object' && current.type === IsmType.DELAYED_FLOW_ROUTER,
    `Expected ${ismAddress} on ${chain} to be a ${IsmType.DELAYED_FLOW_ROUTER}`,
  );

  // Single-instance reconciliation: the tree's composition was validated when
  // it was deployed. Warp apply preserves ownership here because its existing
  // ownership phase handles the shared instance alongside the router.
  return delayedFlowIsmModule.updateDeployedInstance({
    type: IsmType.DELAYED_FLOW_ROUTER,
    warpRouter,
    thresholdBps: userNode.thresholdBps,
    maxDelay: userNode.maxDelay,
    duration: userNode.duration,
    owner: reconcileOwnership ? userNode.owner : current.owner,
    remoteIsms,
  });
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
  assertWarpConfigTimelocksSupportedByProtocols({
    multiProvider,
    warpDeployConfig,
  });

  // Resolve every delayed-flow counterpart before building per-chain batches.
  // Initial deployment already enrolled these pairs; this final pass repairs
  // any drift while the deployer still owns the instances.
  const hasDelayedFlow = Object.values(warpDeployConfig).some(
    (config) =>
      typeof config.interchainSecurityModule === 'object' &&
      config.interchainSecurityModule !== null &&
      collectHybridIsmNodes(config.interchainSecurityModule).some(
        (node) => node.type === IsmType.DELAYED_FLOW_ROUTER,
      ),
  );
  const delayedFlowTargets = hasDelayedFlow
    ? await deriveDelayedFlowEnrollmentTargets(
        multiProvider,
        warpDeployConfig,
        deployedContracts,
        await readInstalledHybridIsmAddresses(multiProvider, deployedContracts),
      )
    : {};

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
          const targetOwner = resolvedConfigMap[currentChain].owner;
          const expectedConfig: HypTokenRouterConfig = {
            ...actualConfig,
            owner: targetOwner,
            // Deployment leaves the router and its shared hybrid instance with
            // the deployer until this final pass. Describe their common target
            // owner on both config surfaces so EvmWarpModule can transfer them
            // together after enrollment.
            interchainSecurityModule:
              typeof actualConfig.interchainSecurityModule === 'object' &&
              actualConfig.interchainSecurityModule
                ? mapHybridIsmNodes(
                    actualConfig.interchainSecurityModule,
                    (node) => ({ ...node, owner: targetOwner }),
                  )
                : actualConfig.interchainSecurityModule,
            hook:
              typeof actualConfig.hook === 'object' && actualConfig.hook
                ? mapHybridHookNodes(actualConfig.hook, (node) => ({
                    ...node,
                    owner: targetOwner,
                  }))
                : actualConfig.hook,
            // Deploy set the ProxyAdmin owner to the intermediate deployer owner
            // so post-deploy enrollment could be self-signed. actualConfig reads
            // that live (deployer) owner, so carry the configured owner through
            // here — otherwise the deferred update sees no change and the
            // deployer keeps upgrade authority over the proxy.
            proxyAdmin: actualConfig.proxyAdmin && {
              address: actualConfig.proxyAdmin.address,
              owner:
                resolvedConfigMap[currentChain].proxyAdmin?.owner ??
                resolvedConfigMap[currentChain].owner,
            },
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

          const { txs, feeTxs, ownershipTxs } = await evmWarpModule.updateSplit(
            expectedConfig,
            {
              routingDestinations: Object.keys(remoteRouters).map((domain) =>
                parseInt(domain, 10),
              ),
            },
          );
          transactions = [...txs, ...feeTxs];

          const delayedFlowTarget = delayedFlowTargets[currentChain];
          if (delayedFlowTarget) {
            transactions.push(
              ...(await buildDelayedFlowEnrollmentTxs({
                chain: currentChain,
                multiProvider,
                registryAddresses,
                warpRouter: deployedContracts[currentChain],
                target: delayedFlowTarget,
                allTargets: delayedFlowTargets,
                reconcileOwnership: false,
              })),
            );
          }

          // The router, ProxyAdmin, and shared hybrid move together only after
          // router and delayed-flow enrollment have converged.
          transactions.push(...ownershipTxs);

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
            validateWarpConfigForAltVM(
              expectedConfig,
              currentChain,
              chainMetadata.protocol,
            ),
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
