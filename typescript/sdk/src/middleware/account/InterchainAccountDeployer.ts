import { ethers } from 'ethers';

import { HyperlaneContracts } from '../../contracts/types.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer.js';
import { ProxiedRouterConfig, RouterConfig } from '../../router/types.js';
import { ChainName } from '../../types.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';

export type InterchainAccountConfig = ProxiedRouterConfig;

export class InterchainAccountDeployer extends ProxiedRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountFactories,
  'interchainAccountRouter'
> {
  readonly routerContractName = 'interchainAccountRouter';

  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, interchainAccountFactories, {
      contractVerifier,
    });
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
