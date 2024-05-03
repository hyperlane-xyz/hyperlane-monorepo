import { PopulatedTransaction } from 'ethers';

import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EthersV5Transaction,
  ProviderType,
} from '../providers/ProviderType.js';
import { RouterConfig } from '../router/types.js';
import { TokenConfig } from '../token/config.js';
import { HypERC20Factories } from '../token/contracts.js';
import { HypERC20Deployer } from '../token/deploy.js';
import {
  DerivedTokenRouterConfig,
  DerivedTokenType,
  EvmERC20WarpRouteReader,
} from '../token/read.js';
import { TokenRouterConfig } from '../token/types.js';
import { ChainMap, ChainNameOrId } from '../types.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';
import { EvmIsmModule } from './EvmIsmModule.js';

export class EvmERC20WarpCrudModule extends CrudModule<
  ProtocolType.Ethereum,
  TokenRouterConfig,
  HyperlaneContracts<HypERC20Factories>
> {
  protected logger = rootLogger.child({ module: 'EvmERC20WarpCrudModule' });
  reader: EvmERC20WarpRouteReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: CrudModuleArgs<
      TokenRouterConfig,
      HyperlaneContracts<HypERC20Factories>
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
  public async read(address: Address): Promise<DerivedTokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(address);
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
    config: TokenRouterConfig,
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
   * 1. If the `config.interchainSecurityModule` is an object,
   *  - Checks if the current onchain ISM configuration matches the provided configuration.
   *  - If not, it deploys a new ISM module, and updates the contract's ISM.
   * 2. If the `config.interchainSecurityModule` is a string
   *  - It attempts to derive the ISM from the provided string, and updates the contract's ISM.
   *
   * @param config - The token router configuration, including the ISM configuration.
   * @returns An array of Ethereum transactions that need to be executed to update the ISM configuration.
   */
  async updateIsm(config: TokenRouterConfig): Promise<EthersV5Transaction[]> {
    const transactions: EthersV5Transaction[] = [];

    const contractToUpdate = await this.args.addresses[
      config.type as DerivedTokenType // Cast because cast.types needs to be narrowed
    ].deployed();

    if (typeof config.interchainSecurityModule === 'object') {
      const onchainConfig = await this.read(contractToUpdate.address);
      if (
        config.interchainSecurityModule.type !==
        onchainConfig.interchainSecurityModule!.type
      ) {
        // Deploy & set ISM
        const ismModule = await this.deployIsm(config.interchainSecurityModule);
        transactions.push(
          this.createTransaction(
            await contractToUpdate.populateTransaction.setInterchainSecurityModule(
              ismModule,
            ),
          ),
        );
      }
    } else if (typeof config.interchainSecurityModule === 'string') {
      // Derive & set ISM
      const ism = await this.reader.evmIsmReader.deriveIsmConfig(
        config.interchainSecurityModule,
      );
      transactions.push(
        this.createTransaction(
          await contractToUpdate.populateTransaction.setInterchainSecurityModule(
            ism.address,
          ),
        ),
      );
    }

    return transactions;
  }

  /**
   * Updates an existing Warp route Hook with a given configuration.
   *
   * @param config - The token router configuration, including the hook configuration to update.
   * @returns An array of Ethereum transactions that can be executed to update the hook.
   */
  async updateHook(config: TokenRouterConfig): Promise<EthersV5Transaction[]> {
    const transactions: EthersV5Transaction[] = [];

    const contractToUpdate = await this.args.addresses[
      config.type as DerivedTokenType // Cast because cast.types needs to be narrowed
    ].deployed();

    if (typeof config.hook === 'string') {
      // Derive & set Hook
      const hook = await this.reader.evmHookReader.deriveHookConfig(
        config.hook,
      );
      transactions.push(
        this.createTransaction(
          await contractToUpdate.populateTransaction.setHook(hook.address),
        ),
      );
    }

    return transactions;
  }

  /**
   * Deploys the ISM using the provided configuration.
   *
   * @param config - The configuration for the ISM to be deployed.
   * @returns The deployed ISM contract address.
   */
  async deployIsm(config: IsmConfig): Promise<string> {
    const evmIsmModule = await EvmIsmModule.create({
      chain: this.args.chain,
      config,
      deployer: '' as any,
      factories: '' as any,
      multiProvider: this.multiProvider,
    });
    return evmIsmModule.serialize().deployedIsm;
  }

  /**
   * Deploys the Warp Route
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpCrudModule.
   */
  public static async create({
    chain,
    config,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: TokenRouterConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmERC20WarpCrudModule> {
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deploy({
      [chain]: config,
    } as ChainMap<TokenConfig & RouterConfig>);

    return new EvmERC20WarpCrudModule(multiProvider, {
      addresses: deployedContracts[chain],
      chain,
      config,
    });
  }

  createTransaction(transaction: PopulatedTransaction): EthersV5Transaction {
    return {
      transaction,
      type: ProviderType.EthersV5,
    };
  }
}
