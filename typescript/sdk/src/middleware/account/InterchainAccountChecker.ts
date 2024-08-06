import { objMap } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterChecker } from '../../router/ProxiedRouterChecker.js';
import { ChainMap } from '../../types.js';

import { InterchainAccount } from './InterchainAccount.js';
import { InterchainAccountConfig } from './InterchainAccountDeployer.js';
import { InterchainAccountFactories } from './contracts.js';

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
    console.log('configMap', configMap);
    console.log('Object.keys(configMap)', Object.keys(configMap));
    console.log('app.contractsMap', app.contractsMap);
    console.log('Object.keys(app.contractsMap)', Object.keys(app.contractsMap));
    console.log('this.app.chains()', app.chains());
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
