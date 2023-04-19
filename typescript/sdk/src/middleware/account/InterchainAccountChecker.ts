import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker';
import { ChainName } from '../../types';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountConfig } from './InterchainAccountDeployer';
import { InterchainAccountFactories } from './contracts';
import { InterchainAccountViolationType } from './types';

export class InterchainAccountChecker extends ProxiedRouterChecker<
  InterchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {
  async checkChain(chain: ChainName): Promise<void> {
    await super.checkChain(chain);
    await this.checkInterchainSecurityModule(chain);
  }

  async checkInterchainSecurityModule(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];
    if (config.interchainSecurityModule) {
      throw new Error(
        'Configuration of ISM address not supported in ICA checker',
      );
    }

    const router = this.app.getContracts(chain).interchainAccountRouter;
    const ism = await router.interchainSecurityModule();
    if (utils.eqAddress(ism, ethers.constants.AddressZero)) {
      this.addViolation({
        type: InterchainAccountViolationType.InterchainSecurityModule,
        chain,
        contract: router,
        expected: true,
        actual: false,
      });
    }
  }
}
