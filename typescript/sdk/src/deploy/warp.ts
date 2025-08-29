import { Ownable__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  isObjEmpty,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { CCIPContractCache } from '../ccip/utils.js';
import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { EvmHookModule } from '../hook/EvmHookModule.js';
import { HookConfig } from '../hook/types.js';
import { CosmosNativeIsmModule } from '../ism/CosmosNativeIsmModule.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { RadixIsmModule } from '../ism/RadixIsmModule.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GroupedTransactions } from '../providers/ProviderType.js';
import { CosmosNativeWarpModule } from '../token/CosmosNativeWarpModule.js';
import { EvmERC20WarpModule } from '../token/EvmERC20WarpModule.js';
import { RadixWarpModule } from '../token/RadixWarpModule.js';
import { HypERC20Factories, hypERC20factories } from '../token/contracts.js';
import { CosmosNativeDeployer } from '../token/cosmosnativeDeploy.js';
import { HypERC20Deployer, HypERC721Deployer } from '../token/deploy.js';
import { RadixDeployer } from '../token/radixDeploy.js';
import {
  HypTokenRouterConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainMap, IMultiProtocolSignerManager } from '../types.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import { HyperlaneProxyFactoryDeployer } from './HyperlaneProxyFactoryDeployer.js';
import { ContractVerifier } from './verify/ContractVerifier.js';
import { ExplorerLicenseType } from './verify/types.js';

type ChainAddresses = Record<string, string>;

export async function executeWarpDeploy(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  multiProtocolSigner: IMultiProtocolSignerManager,
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
    multiProtocolSigner,
    registryAddresses,
    ismFactoryDeployer,
    contractVerifier,
  );

  let deployedContracts: ChainMap<Address> = {};

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
          (chain, _) => multiProtocolSigner.getCosmosNativeSigner(chain)!,
        );

        const deployer = new CosmosNativeDeployer(multiProvider, signersMap);
        deployedContracts = {
          ...deployedContracts,
          ...(await deployer.deploy(protocolSpecificConfig)),
        };

        break;
      }
      case ProtocolType.Radix: {
        const signersMap = objMap(
          protocolSpecificConfig,
          (chain, _) => multiProtocolSigner.getRadixSigner(chain)!,
        );

        const deployer = new RadixDeployer(multiProvider, signersMap);
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

  return deployedContracts;
}

async function resolveWarpIsmAndHook(
  warpConfig: WarpRouteDeployConfigMailboxRequired,
  multiProvider: MultiProvider,
  multiProtocolSigner: IMultiProtocolSignerManager,
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
        multiProtocolSigner,
        contractVerifier,
        ismFactoryDeployer,
        warpConfig: config,
      }); // TODO write test

      config.hook = await createWarpHook({
        ccipContractCache,
        chain,
        chainAddresses,
        multiProvider,
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
  multiProtocolSigner,
  contractVerifier,
  warpConfig,
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  multiProvider: MultiProvider;
  multiProtocolSigner: IMultiProtocolSignerManager;
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
    case ProtocolType.CosmosNative: {
      const signer = multiProtocolSigner!.getCosmosNativeSigner(chain);

      const cosmosIsmModule = await CosmosNativeIsmModule.create({
        chain,
        multiProvider: multiProvider,
        addresses: {
          mailbox: chainAddresses.mailbox,
        },
        config: interchainSecurityModule,
        signer,
      });
      const { deployedIsm } = cosmosIsmModule.serialize();
      return deployedIsm;
    }
    case ProtocolType.Radix: {
      const signer = multiProtocolSigner!.getRadixSigner(chain);

      const radixIsmModule = await RadixIsmModule.create({
        chain,
        multiProvider: multiProvider,
        addresses: {
          mailbox: chainAddresses.mailbox,
        },
        config: interchainSecurityModule,
        signer,
      });
      const { deployedIsm } = radixIsmModule.serialize();
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
  multiProvider,
  contractVerifier,
  warpConfig,
}: {
  ccipContractCache: CCIPContractCache;
  chain: string;
  chainAddresses: Record<string, string>;
  multiProvider: MultiProvider;
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
    case ProtocolType.CosmosNative: {
      rootLogger.info(
        `No warp hooks for Cosmos Native chains, skipping deployment.`,
      );
      return hook;
    }
    case ProtocolType.Radix: {
      rootLogger.info(`No warp hooks for Radix chains, skipping deployment.`);
      return hook;
    }
    default:
      throw new Error(`Protocol type ${protocolType} not supported`);
  }
}

export async function updateTokenOwners({
  deployedContracts,
  warpDeployConfig,
  multiProvider,
  multiProtocolSigner,
}: {
  deployedContracts: ChainMap<string>;
  multiProvider: MultiProvider;
  multiProtocolSigner: IMultiProtocolSignerManager;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}) {
  for (const chain of Object.keys(warpDeployConfig)) {
    const signerAddress = await multiProtocolSigner.getSignerAddress(chain);
    const newOwner = warpDeployConfig[chain].owner;
    const tokenAddress = deployedContracts[chain];

    if (signerAddress === newOwner) {
      continue;
    }

    switch (multiProvider.getProtocol(chain)) {
      case ProtocolType.Ethereum: {
        console.log('send eth transaction');
        multiProvider.sendTransaction(chain, {
          chainId: multiProvider.getEvmChainId(chain),
          annotation: `Transferring ownership of ${tokenAddress} from ${
            signerAddress
          } to ${newOwner}`,
          to: tokenAddress,
          data: Ownable__factory.createInterface().encodeFunctionData(
            'transferOwnership',
            [newOwner],
          ),
        });
        break;
      }
      case ProtocolType.CosmosNative: {
        const signer = multiProtocolSigner.getCosmosNativeSigner(chain);

        const { token } = await signer.query.warp.Token({
          id: tokenAddress,
        });

        await signer.setToken({
          token_id: tokenAddress,
          ism_id: token?.ism_id ?? '',
          new_owner: newOwner,
          renounce_ownership: !newOwner, // if owner is empty we renounce the ownership
        });
        break;
      }
      case ProtocolType.Radix: {
        const signer = multiProtocolSigner.getRadixSigner(chain);
        await signer.tx.warp.setTokenOwner({
          token: tokenAddress,
          new_owner: newOwner,
        });
        break;
      }
      default: {
        throw new Error(
          `Protocol type ${multiProvider.getProtocol(chain)} not supported`,
        );
      }
    }
  }
}

export async function enrollCrossChainRouters(
  {
    multiProvider,
    multiProtocolSigner,
    registryAddresses,
    warpDeployConfig,
  }: {
    multiProvider: MultiProvider;
    multiProtocolSigner: IMultiProtocolSignerManager;
    registryAddresses: ChainMap<ChainAddresses>;
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
    const protocol = multiProvider.getProtocol(chain);

    const allRemoteChains = multiProvider
      .getRemoteChains(chain)
      .filter((c) => allChains.includes(c));

    const protocolTransactions = {} as GroupedTransactions;

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
        } = registryAddresses[chain];

        const evmWarpModule = new EvmERC20WarpModule(multiProvider, {
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
              routers[multiProvider.getDomainId(c).toString()] = {
                address: addressToBytes32(deployedContracts[c]),
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
        const signer = multiProtocolSigner.getCosmosNativeSigner(chain);

        const cosmosNativeWarpModule = new CosmosNativeWarpModule(
          multiProvider,
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
              routers[multiProvider.getDomainId(c).toString()] = {
                address: addressToBytes32(deployedContracts[c]),
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
      case ProtocolType.Radix: {
        const signer = multiProtocolSigner.getRadixSigner(chain);

        const radixWarpModule = new RadixWarpModule(
          multiProvider,
          {
            chain,
            config: configMapToDeploy[chain],
            addresses: {
              deployedTokenRoute: deployedContracts[chain],
            },
          },
          signer,
        );
        const actualConfig = await radixWarpModule.read();
        const expectedConfig = {
          ...actualConfig,
          remoteRouters: (() => {
            const routers: Record<string, { address: string }> = {};
            for (const c of allRemoteChains) {
              routers[multiProvider.getDomainId(c).toString()] = {
                address: addressToBytes32(deployedContracts[c]),
              };
            }
            return routers;
          })(),
        };

        const transactions = await radixWarpModule.update(expectedConfig);

        if (transactions.length) {
          protocolTransactions[ProtocolType.Radix] = {
            [chain]: transactions,
          };
        }

        break;
      }
      default: {
        throw new Error(`Protocol type ${protocol} not supported`);
      }
    }

    for (const protocol of Object.keys(protocolTransactions)) {
      switch (protocol) {
        case ProtocolType.Ethereum: {
          // TODO: RADIX
          // why does this fail?
          // for (const chain of Object.keys(protocolTransactions[protocol])) {
          //   const transactions = protocolTransactions[protocol][chain];
          //   const signer = multiProtocolSigner.getEVMSigner(chain);

          //   for (const transaction of transactions) {
          //     console.log('transaction', transaction);
          //     await signer.sendTransaction(transaction);
          //   }
          // }

          break;
        }
        case ProtocolType.CosmosNative: {
          for (const chain of Object.keys(protocolTransactions[protocol])) {
            const transactions = protocolTransactions[protocol][chain];
            const signer = multiProtocolSigner.getCosmosNativeSigner(chain);

            await signer.signAndBroadcast(
              signer.account.address,
              transactions,
              2,
            );
          }

          break;
        }
        case ProtocolType.Radix: {
          for (const chain of Object.keys(protocolTransactions[protocol])) {
            const transactions = protocolTransactions[protocol][chain];
            const signer = multiProtocolSigner.getRadixSigner(chain);

            for (const transaction of transactions) {
              await signer.signer.signAndBroadcast(transaction.manifest);
            }
          }

          break;
        }
        default: {
          throw new Error('Chain protocol is not supported yet!');
        }
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
