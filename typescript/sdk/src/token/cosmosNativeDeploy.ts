import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

import { AddressesMap } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class CosmosNativeDeployer {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly signer: SigningHyperlaneModuleClient,
  ) {}

  async deploy(
    configMap: WarpRouteDeployConfigMailboxRequired,
  ): Promise<ChainMap<AddressesMap>> {
    const resolvedConfigMap = objMap(configMap, (_, config) => ({
      gas: gasOverhead(config.type),
      ...config,
    }));

    let result: ChainMap<AddressesMap> = {};

    for (const chain of Object.keys(resolvedConfigMap)) {
      const config = resolvedConfigMap[chain];

      switch (config.type) {
        case TokenType.collateral: {
          const { response: collateralToken } =
            await this.signer.createCollateralToken({
              origin_mailbox: config.mailbox,
              origin_denom: config.token,
            });
          result[chain] = {
            token_id: collateralToken.id,
          };
          break;
        }
        case TokenType.synthetic: {
          const { response: syntheticToken } =
            await this.signer.createSyntheticToken({
              origin_mailbox: config.mailbox,
            });
          result[chain] = {
            token_id: syntheticToken.id,
          };
          break;
        }
        default: {
          throw new Error(`Token type ${config.type} not supported`);
        }
      }

      for (const domainId of Object.keys(config.remoteRouters || {})) {
        assert(config.remoteRouters, ``);

        await this.signer.enrollRemoteRouter({
          token_id: result[chain].token_id,
          remote_router: {
            receiver_domain: parseInt(domainId),
            receiver_contract: (config.remoteRouters || {})[domainId].address,
            gas: (config.destinationGas || {})[domainId] ?? '0',
          },
        });
      }
    }

    return {};
  }
}
