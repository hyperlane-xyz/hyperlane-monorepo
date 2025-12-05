import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  AltVMDeployer,
  AltVMHookModule,
  AltVMIsmModule,
  AltVMWarpModule,
} from '@hyperlane-xyz/deploy-sdk';
import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { HookConfig as ProviderHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { IsmConfig as ProviderIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { WarpConfig as ProviderWarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import {
  Address,
  addressToBytes32,
  assert,
  isObjEmpty,
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
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { IsmConfig } from '../ism/types.js';
import { altVmChainLookup } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { TypedAnnotatedTransaction } from '../providers/ProviderType.js';
import { DestinationGas, RemoteRouters } from '../router/types.js';
import { EvmERC20WarpModule } from '../token/EvmERC20WarpModule.js';
import { gasOverhead } from '../token/config.js';
import { HypERC20Factories, hypERC20factories } from '../token/contracts.js';
import { HypERC20Deployer, HypERC721Deployer } from '../token/deploy.js';
import {
  HypTokenRouterConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainMap } from '../types.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import { HyperlaneProxyFactoryDeployer } from './HyperlaneProxyFactoryDeployer.js';
import { ContractVerifier } from './verify/ContractVerifier.js';

type ChainAddresses = Record<string, string>;

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

  // For each chain in WarpRouteConfig, deploy each Ism Factory, if it's not in the registry
  // Then return a modified config with the ism and/or hook address as a string
  const modifiedConfig = await resolveWarpIsmAndHook(
    warpDeployConfig,
    multiProvider,
    altVmSigners,
    registryAddresses,
    ismFactoryDeployer,
    contractVerifier,
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
      (chainName, config): config is any =>
        multiProvider.getProtocol(chainName) === protocol &&
        !config.foreignDeployment,
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
      default: {
        const signersMap = objMap(protocolSpecificConfig, (chain, _) =>
          mustGet(altVmSigners, chain),
        );

        const deployer = new AltVMDeployer(signersMap);
        deployedContracts = {
          ...deployedContracts,
          ...(await deployer.deploy(
            protocolSpecificConfig as Record<string, ProviderWarpConfig>,
          )),
        };

        break;
      }
    }
  }

  return deployedContracts;
}

async function resolveWarpIsmAndHook(
  warpConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>,
  registryAddresses: ChainMap<ChainAddresses>,
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer,
  contractVerifier: ContractVerifier,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  return promiseObjAll(
    objMap(warpConfig, async (chain, config) => {
      const ccipContractCache = new CCIPContractCache(registryAddresses);
      const chainAddresses = registryAddresses[chain];

      if (!chainAddresses) {
        throw `Registry factory addresses not found for ${chain}.`;
      }

      config.interchainSecurityModule = await createWarpIsm({
        ccipContractCache,
        chain,
        chainAddresses,
        multiProvider,
        altVmSigners,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      }); // TODO write test

      config.hook = await createWarpHook({
        ccipContractCache,
        chain,
        chainAddresses,
        multiProvider,
        altVmSigners,
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

  rootLogger.info(`Loading registry factory addresses for ${chain}...`);

  rootLogger.info(
    `Creating ${interchainSecurityModule.type} ISM for token on ${chain} chain...`,
  );

  rootLogger.info(
    `Finished creating ${interchainSecurityModule.type} ISM for token on ${chain} chain.`,
  );

  const protocolType = multiProvider.getProtocol(chain);

  switch (protocolType) {
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
      const ismModule = await AltVMIsmModule.create({
        chain,
        addresses: {
          mailbox: chainAddresses.mailbox,
        },
        // FIXME: not all ISM types are supported yet
        config: interchainSecurityModule as ProviderIsmConfig | string,
        chainLookup: altVmChainLookup(multiProvider),
        signer,
      });
      const { deployedIsm } = ismModule.serialize();
      return deployedIsm;
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
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  multiProvider: MultiProvider;
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
  contractVerifier?: ContractVerifier;
  warpConfig: HypTokenRouterConfig;
  ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
}): Promise<HookConfig | undefined> {
  const { hook } = warpConfig;

  if (!hook || typeof hook === 'string') {
    rootLogger.info(
      `Config Hook is ${!hook ? 'empty' : hook}, skipping deployment.`,
    );
    return hook;
  }

  rootLogger.info(`Loading registry factory addresses for ${chain}...`);

  rootLogger.info(`Creating ${hook.type} Hook for token on ${chain} chain...`);

  const protocolType = multiProvider.getProtocol(chain);

  switch (protocolType) {
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
      const hookModule = await AltVMHookModule.create({
        chain,
        chainLookup: multiProvider,
        addresses: {
          deployedHook: '',
          mailbox: chainAddresses.mailbox,
        },
        // FIXME: not all Hook types are supported yet
        config: hook as ProviderHookConfig | string,
        signer,
      });
      const { deployedHook } = hookModule.serialize();
      return deployedHook;
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

  const updateTransactions = {} as ChainMap<TypedAnnotatedTransaction[]>;

  const supportedChains = Object.keys(
    objFilter(
      resolvedConfigMap,
      (_, config: any): config is any => !config.foreignDeployment,
    ),
  );

  for (const currentChain of supportedChains) {
    const protocol = multiProvider.getProtocol(currentChain);

    const remoteRouters: RemoteRouters = Object.fromEntries(
      Object.entries(deployedContracts)
        .filter(([chain, _address]) => chain !== currentChain)
        .map(([chain, address]) => [
          multiProvider.getDomainId(chain).toString(),
          {
            address: addressToBytes32(address),
          },
        ]),
    );

    const destinationGas: DestinationGas = Object.fromEntries(
      Object.entries(deployedContracts)
        .filter(([chain, _address]) => chain !== currentChain)
        .map(([chain, _address]) => [
          multiProvider.getDomainId(chain).toString(),
          resolvedConfigMap[chain].gas.toString(),
        ]),
    );

    for (const domainId of Object.keys(remoteRouters)) {
      rootLogger.debug(
        `Creating enroll remote router transactions with remote domain id ${domainId} and address ${remoteRouters[domainId]} on chain ${currentChain}`,
      );
    }

    switch (protocol) {
      case ProtocolType.Ethereum: {
        const {
          domainRoutingIsmFactory,
          staticMerkleRootMultisigIsmFactory,
          staticMessageIdMultisigIsmFactory,
          staticAggregationIsmFactory,
          staticAggregationHookFactory,
          staticMerkleRootWeightedMultisigIsmFactory,
          staticMessageIdWeightedMultisigIsmFactory,
        } = registryAddresses[currentChain];

        const evmWarpModule = new EvmERC20WarpModule(multiProvider, {
          chain: currentChain,
          config: resolvedConfigMap[currentChain],
          addresses: {
            deployedTokenRoute: deployedContracts[currentChain],
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
        const expectedConfig: HypTokenRouterConfig = {
          ...actualConfig,
          owner: resolvedConfigMap[currentChain].owner,
          remoteRouters,
          destinationGas,
        };

        const transactions = await evmWarpModule.update(expectedConfig, {
          routingDestinations: Object.keys(remoteRouters).map((domain) =>
            multiProvider.getDomainId(domain),
          ),
        });

        if (transactions.length) {
          updateTransactions[currentChain] = transactions;
        }

        break;
      }
      default: {
        const signer = mustGet(altVmSigners, currentChain);

        const warpModule = new AltVMWarpModule(
          altVmChainLookup(multiProvider),
          signer,
          {
            chain: currentChain,
            config: resolvedConfigMap[currentChain] as ProviderWarpConfig,
            addresses: {
              deployedTokenRoute: deployedContracts[currentChain],
            },
          },
        );
        const actualConfig = await warpModule.read();
        const expectedConfig: HypTokenRouterConfig = {
          ...actualConfig,
          owner: resolvedConfigMap[currentChain].owner,
          remoteRouters,
          destinationGas,
        };

        const transactions = await warpModule.update(
          expectedConfig as ProviderWarpConfig,
        );

        if (transactions.length) {
          updateTransactions[currentChain] = transactions;
        }
      }
    }

    rootLogger.debug(
      `Created enroll router update transactions for chain ${currentChain}`,
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
