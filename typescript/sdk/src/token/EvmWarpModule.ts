import {
  Address,
  ProtocolType,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { attachContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts.js';
import { EvmHookModule } from '../hook/EvmHookModule.js';
import { HookConfig } from '../hook/types.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EthersV5Transaction,
  createAnnotatedEthersV5Transaction,
} from '../providers/ProviderType.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainNameOrId } from '../types.js';

import {
  DerivedTokenRouterConfig,
  EvmERC20WarpRouteReader,
} from './EvmERC20WarpRouteReader.js';
import { TokenConfig } from './config.js';
import { HypERC20Factories } from './contracts.js';
import { HypERC20Deployer } from './deploy.js';

export class EvmERC20WarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  DerivedTokenRouterConfig,
  HyperlaneContracts<HypERC20Factories> & {
    deployedTokenRoute: Address;
  }
> {
  protected logger = rootLogger.child({
    module: 'EvmERC20WarpModule',
  });
  reader: EvmERC20WarpRouteReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<
      DerivedTokenRouterConfig,
      HyperlaneContracts<HypERC20Factories> & {
        deployedTokenRoute: Address;
      }
    >,
  ) {
    super(args);

    this.reader = new EvmERC20WarpRouteReader(multiProvider, args.chain);
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  public async read(): Promise<DerivedTokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(
      this.args.addresses.deployedTokenRoute,
    );
  }

  /**
   * Updates the Warp Route contract with the provided configuration.
   *
   * @remark Currently only supports updating ISM or hook
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract, or an error if the update failed.
   */
  public async update(
    expectedConfig: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    const actualConfig = await this.read();

    return Promise.all([
      ...(await this.updateIsm(expectedConfig, actualConfig)),
      ...(await this.updateHook(expectedConfig, actualConfig)),
    ]);
  }

  /**
   * Updates an existing Warp route ISM with a given configuration.
   *
   * This method handles two cases:
   * 1. If the `config.interchainSecurityModule.address` is undefined
   *  - Deploys a new ISM module
   *  - Updates the contract's ISM.
   * 2. If the `config.interchainSecurityModule.address` is defined.
   *  - Checks if the current onchain ISM configuration matches the provided configuration.
   *  - Updates the contract's ISM.
   *
   * @param expectedconfig - The expected token router configuration, including the ISM configuration.
   * @param actualConfig - The on-chain router configuration, including the ISM configuration.
   * @returns An array of Ethereum transactions that need to be executed to update the ISM configuration.
   */
  async updateIsm(
    expectedconfig: DerivedTokenRouterConfig,
    actualConfig: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    const transactions: EthersV5Transaction[] = [];
    if (expectedconfig.interchainSecurityModule) {
      const contractToUpdate = await this.args.addresses[
        expectedconfig.type
      ].deployed();

      // If an address is not defined, deploy a new Ism
      const expectedIsmConfig = !expectedconfig.interchainSecurityModule.address
        ? await this.deployIsm(
            expectedconfig.ismFactoryAddresses as HyperlaneAddresses<ProxyFactoryFactories>,
            expectedconfig.interchainSecurityModule,
          )
        : expectedconfig.interchainSecurityModule;
      const actualIsmConfig = actualConfig.interchainSecurityModule;
      if (!deepEquals(expectedIsmConfig, actualIsmConfig)) {
        transactions.push(
          createAnnotatedEthersV5Transaction({
            annotation: `Setting ISM for Warp Route to ${
              (expectedIsmConfig as any).address
            }`,
            chainId: Number(this.multiProvider.getChainId(this.args.chain)),
            to: contractToUpdate.address,
            data: contractToUpdate.interface.encodeFunctionData(
              'setInterchainSecurityModule',
              [(expectedIsmConfig as any).address], // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
            ),
          }),
        );
      }
    }
    return transactions;
  }

  /**
   * Deploys the ISM using the provided configuration.
   *
   * @param config - The configuration for the ISM to be deployed.
   * @returns The config used to deploy the Ism with address attached
   */
  public async deployIsm(
    ismFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>,
    interchainSecurityModule: IsmConfig,
  ): Promise<IsmConfig> {
    // Take the config.ismFactoryAddresses, de-serialize them into Contracts, and pass into EvmIsmModule.create
    const factories = attachContracts(
      ismFactoryAddresses,
      proxyFactoryFactories,
    );
    const ism = await EvmIsmModule.create({
      chain: this.args.chain,
      config: interchainSecurityModule!,
      deployer: new HyperlaneProxyFactoryDeployer(this.multiProvider),
      factories,
      multiProvider: this.multiProvider,
    });

    (interchainSecurityModule as any).address = ism.serialize().deployedIsm; // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
    return interchainSecurityModule;
  }

  /**
   * Updates an existing Warp route Hook with a given configuration.
   *
   * @param expectedConfig - The token router configuration, including the hook configuration to update.
   * @param actualConfig - The on-chain router configuration, including the hook configuration to update.
   * @returns An array of Ethereum transactions that can be executed to update the hook.
   */
  async updateHook(
    expectedConfig: DerivedTokenRouterConfig,
    actualConfig: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    const transactions: EthersV5Transaction[] = [];
    if (expectedConfig.hook) {
      // @todo Uncomment after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
      // const contractToUpdate = await this.args.addresses[
      //   expectedConfig.type
      // ].deployed();
      // // If an address is not defined, deploy a new Hook
      // const expectedHookConfig = !expectedConfig.hook.address
      //   ? await this.deployHook(expectedConfig.hook)
      //   : expectedConfig.hook;
      // const actualHookConfig = actualConfig.hook;
      // if (!deepEquals(expectedHookConfig, actualHookConfig)) {
      //   transactions.push({
      //     transaction: await contractToUpdate.populateTransaction.setHook(
      //       expectedHookConfig.address,
      //     ),
      //     type: ProviderType.EthersV5,
      //   });
      // }
    }
    return transactions;
  }

  /**
   * Deploys the Hook using the provided configuration.
   *
   * @param config - The configuration for the Hook to be deployed.
   * @returns The config used to deploy the Hook with address attached
   */
  public async deployHook(hook: HookConfig): Promise<HookConfig> {
    const ism = await EvmHookModule.create(hook);

    (hook as any).address = ism.serialize().deployedHook; // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
    return hook;
  }

  /**
   * Deploys the Warp Route
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpHyperlaneModule.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: DerivedTokenRouterConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmERC20WarpModule> {
    const { chain, config, multiProvider } = params;
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deploy({
      [chain]: config,
    } as ChainMap<TokenConfig & RouterConfig>);

    return new EvmERC20WarpModule(multiProvider, {
      addresses: {
        ...deployedContracts[chain],
        deployedTokenRoute: deployedContracts[chain][config.type].address,
      },
      chain,
      config,
    });
  }
}
