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
  ProviderType,
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

export class EvmERC20WarpHyperlaneModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  DerivedTokenRouterConfig,
  HyperlaneContracts<HypERC20Factories> & {
    deployedTokenRoute: Address;
  }
> {
  protected logger = rootLogger.child({
    module: 'EvmERC20WarpHyperlaneModule',
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
   * @param config - The configuration for the token router to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract, or an error if the update failed.
   */
  public async update(
    config: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    return [
      ...(await this.updateIsm(config)),
      ...(await this.updateHook(config)),
    ];
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
   * @param config - The token router configuration, including the ISM configuration.
   * @returns An array of Ethereum transactions that need to be executed to update the ISM configuration.
   */
  async updateIsm(
    config: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    const transactions: EthersV5Transaction[] = [];
    if (config.interchainSecurityModule) {
      const contractToUpdate = await this.args.addresses[
        config.type
      ].deployed();

      // If an address is not defined, deploy a new Ism
      const expectedIsmConfig = !config.interchainSecurityModule.address
        ? await this.deployIsm(
            config.ismFactoryAddresses as HyperlaneAddresses<ProxyFactoryFactories>,
            config.interchainSecurityModule,
          )
        : config.interchainSecurityModule;

      const actualIsmConfig = await this.read();

      if (!deepEquals(expectedIsmConfig, actualIsmConfig)) {
        transactions.push({
          transaction:
            await contractToUpdate.populateTransaction.setInterchainSecurityModule(
              (expectedIsmConfig as any).address, // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
            ),
          type: ProviderType.EthersV5,
        });
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
   * @param config - The token router configuration, including the hook configuration to update.
   * @returns An array of Ethereum transactions that can be executed to update the hook.
   */
  async updateHook(
    config: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    const transactions: EthersV5Transaction[] = [];
    if (config.hook) {
      // @todo Uncomment after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
      // const contractToUpdate = await this.args.addresses[
      //   config.type
      // ].deployed();
      // // If an address is not defined, deploy a new Hook
      // const expectedHookConfig = !(config.hook as any).address // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
      //   ? await this.deployHook(config.hook)
      //   : config.hook;
      // const actualHookConfig = await this.read();
      // if (!deepEquals(expectedHookConfig, actualHookConfig)) {
      //   transactions.push({
      //     transaction: await contractToUpdate.populateTransaction.setHook(
      //       (expectedHookConfig as any).address, // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
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
  public static async create({
    chain,
    config,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: DerivedTokenRouterConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmERC20WarpHyperlaneModule> {
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deploy({
      [chain]: config,
    } as ChainMap<TokenConfig & RouterConfig>);

    return new EvmERC20WarpHyperlaneModule(multiProvider, {
      addresses: {
        ...deployedContracts[chain],
        deployedTokenRoute: deployedContracts[chain][config.type].address,
      },
      chain,
      config,
    });
  }
}
