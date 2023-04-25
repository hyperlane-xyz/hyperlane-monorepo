import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker';
import { ChainMap } from '../../types';
import { objMap } from '../../utils/objects';

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
    // The checker does not expect an ISM in it's config.
    // Instead, we set the ISM to match the ISM address from the app.
    const configMapWithIsm = objMap(configMap, (chain, config) => {
      if (config.interchainSecurityModule) {
        throw new Error(
          'Configuration of ISM address not supported in ICA checker',
        );
      }
      return {
        ...config,
        interchainSecurityModule:
          app.contractsMap[chain].interchainAccountIsm.address,
      };
    });
    super(multiProvider, app, configMapWithIsm);
  }
}
