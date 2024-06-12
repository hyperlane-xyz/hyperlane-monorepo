import { MailboxClient__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { EvmHookModule } from '../hook/EvmHookModule.js';
import { HookConfig } from '../hook/types.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { HypERC20Deployer } from './deploy.js';
import { TokenRouterConfig } from './schemas.js';

export class EvmERC20WarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  TokenRouterConfig,
  {
    deployedTokenRoute: Address;
  }
> {
  protected logger = rootLogger.child({
    module: 'EvmERC20WarpModule',
  });
  reader: EvmERC20WarpRouteReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      TokenRouterConfig,
      {
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
  public async read(): Promise<TokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(
      this.args.addresses.deployedTokenRoute,
    );
  }

  /**
   * Updates the Warp Route contract with the provided configuration.
   *
   * @remark Currently only supports updating ISM or hook.
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract, or an error if the update failed.
   */
  public async update(
    expectedConfig: TokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const actualConfig = await this.read(); // @TODO add normalizer

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
    expectedconfig: TokenRouterConfig,
    actualConfig: TokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const transactions: AnnotatedEV5Transaction[] = [];
    if (expectedconfig.interchainSecurityModule) {
      if (
        !deepEquals(
          expectedconfig.interchainSecurityModule,
          actualConfig.interchainSecurityModule,
        )
      ) {
        const deployedIsm = await this.deployIsm(
          expectedconfig.ismFactoryAddresses as HyperlaneAddresses<ProxyFactoryFactories>,
          expectedconfig.interchainSecurityModule,
          expectedconfig.mailbox,
        );
        const contractToUpdate = MailboxClient__factory.connect(
          this.args.addresses.deployedTokenRoute,
          this.multiProvider.getProvider(this.args.chain),
        );
        transactions.push({
          annotation: `Setting ISM for Warp Route to ${deployedIsm}`,
          chainId: Number(this.multiProvider.getChainId(this.args.chain)),
          to: contractToUpdate.address,
          data: contractToUpdate.interface.encodeFunctionData(
            'setInterchainSecurityModule',
            [deployedIsm], // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
          ),
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
    mailbox: Address,
  ): Promise<Address> {
    const ism = await EvmIsmModule.create({
      chain: this.args.chain,
      config: interchainSecurityModule,
      deployer: new HyperlaneProxyFactoryDeployer(this.multiProvider),
      factories: ismFactoryAddresses,
      multiProvider: this.multiProvider,
      mailbox,
    });

    // Attach the deployedIsm address
    return ism.serialize().deployedIsm; // @todo Remove 'any' after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773 is implemented,
  }

  /**
   * Updates an existing Warp route Hook with a given configuration.
   *
   * @param expectedConfig - The token router configuration, including the hook configuration to update.
   * @param actualConfig - The on-chain router configuration, including the hook configuration to update.
   * @returns An array of Ethereum transactions that can be executed to update the hook.
   */
  async updateHook(
    expectedConfig: TokenRouterConfig,
    _actualConfig: TokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const transactions: AnnotatedEV5Transaction[] = [];
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
   * Deploys the Warp Route.
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpHyperlaneModule.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: TokenRouterConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmERC20WarpModule> {
    const { chain, config, multiProvider } = params;
    const chainName = multiProvider.getChainName(chain);
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deployContracts(chainName, config);

    return new EvmERC20WarpModule(multiProvider, {
      addresses: {
        deployedTokenRoute: deployedContracts[config.type].address,
      },
      chain,
      config,
    });
  }
}
