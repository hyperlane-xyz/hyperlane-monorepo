import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker';
import { ChainMap } from '../../types';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountConfig } from './InterchainAccountDeployer';
import { InterchainAccountFactories } from './contracts';

export class InterchainAccountChecker extends ProxiedRouterChecker<
  InterchainAccountFactories,
  InterchainAccount,
  InterchainAccountConfig
> {
  constructor(
    multiProvider: MultiProvider,
    app: InterchainAccount,
    configMap: ChainMap<InterchainAccountConfig>,
  ) {
    super(multiProvider, app, configMap);
    Object.keys(this.app.contractsMap).forEach((chain) => {
      if (this.configMap[chain].interchainSecurityModule) {
        throw new Error(
          'Configuration of ISM address not supported in ICA checker',
        );
      }
      this.configMap[chain].interchainSecurityModule =
        app.contractsMap[chain].interchainAccountIsm.address;
    });
  }
}
