import { objMap } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { HyperlaneRouterChecker } from '../../router/HyperlaneRouterChecker.js';
import { ChainMap } from '../../types.js';

import { InterchainAccount } from './InterchainAccount.js';
import { InterchainAccountConfig } from './InterchainAccountDeployer.js';
import { InterchainAccountFactories } from './contracts.js';

export class InterchainAccountChecker extends HyperlaneRouterChecker<
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
