import { ethers } from 'ethers';

import { HyperlaneContracts } from '../../contracts/types';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer';
import { ProxiedRouterConfig, RouterConfig } from '../../router/types';
import { ChainName } from '../../types';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';

export type InterchainAccountConfig = ProxiedRouterConfig;

export class InterchainAccountDeployer extends ProxiedRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountFactories,
  'interchainAccountRouter'
> {
  readonly routerContractName = 'interchainAccountRouter';

  constructor(multiProvider: MultiProvider) {
    super(multiProvider, interchainAccountFactories);
  }

  async constructorArgs(_: string, config: RouterConfig): Promise<[string]> {
    return [config.mailbox];
  }

  async initializeArgs(
    chain: string,
    config: RouterConfig,
  ): Promise<[string, string, string]> {
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      config.hook ?? ethers.constants.AddressZero,
      config.interchainSecurityModule! as string, // deployed in deployContracts
      owner,
    ];
  }

  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<HyperlaneContracts<InterchainAccountFactories>> {
    if (config.interchainSecurityModule) {
      throw new Error('Configuration of ISM not supported in ICA deployer');
    }

    const interchainAccountIsm = await this.deployContract(
      chain,
      'interchainAccountIsm',
      [config.mailbox],
    );
    const modifiedConfig = {
      ...config,
      interchainSecurityModule: interchainAccountIsm.address,
    };
    const contracts = await super.deployContracts(chain, modifiedConfig);

    return {
      ...contracts,
      interchainAccountIsm,
    };
  }
}
