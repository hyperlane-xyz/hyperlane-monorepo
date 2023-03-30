import { ContractFactory, ethers } from 'ethers';

import { HyperlaneContracts } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { ProxiedFactories, RouterConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

export abstract class MiddlewareRouterDeployer<
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareFactories extends ProxiedFactories,
  RouterFactory extends ContractFactory,
> extends HyperlaneRouterDeployer<MiddlewareRouterConfig, MiddlewareFactories> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<MiddlewareRouterConfig>,
    factories: MiddlewareFactories,
    protected create2salt = 'middlewarerouter',
  ) {
    super(multiProvider, configMap, factories);
  }

  constructorArgs(
    _chain: ChainName,
    _config: MiddlewareRouterConfig,
  ): Parameters<RouterFactory['deploy']> {
    return [] as any;
  }

  abstract routerContractName(): string;

  async initializeArgs(
    chain: ChainName,
    config: MiddlewareRouterConfig,
  ): Promise<[string, string, string, string]> {
    // configure owner as signer for additional initialization steps
    // ownership is transferred to config.owner in HyperlaneRouterDeployer.deploy
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      owner,
    ];
  }

  async deployContracts(
    chain: ChainName,
    config: MiddlewareRouterConfig,
  ): Promise<HyperlaneContracts<MiddlewareFactories>> {
    const proxyAdmin = await this.deployContract(
      chain,
      'proxyAdmin',
      [] as any, // generic type inference fails here
    );

    const initArgs = await this.initializeArgs(chain, config);
    const proxiedRouter = await this.deployProxiedContract(
      chain,
      this.routerContractName(),
      this.constructorArgs(chain, config),
      initArgs as any, // generic type inference fails here
      proxyAdmin.address,
      {
        create2Salt: this.create2salt,
      },
    );

    this.logger(`Transferring ownership of proxy admin to ${config.owner}`);
    await super.runIfOwner(chain, proxyAdmin, () =>
      this.multiProvider.handleTx(
        chain,
        proxyAdmin.transferOwnership(config.owner),
      ),
    );
    const ret = {
      [this.routerContractName()]: proxiedRouter,
      proxyAdmin,
    };
    return ret as HyperlaneContracts<MiddlewareFactories>;
  }
}
