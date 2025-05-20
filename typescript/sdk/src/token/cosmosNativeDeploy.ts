import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class CosmosNativeDeployer {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly signersMap: ChainMap<SigningHyperlaneModuleClient>,
  ) {}

  async deploy(
    configMap: WarpRouteDeployConfigMailboxRequired,
  ): Promise<ChainMap<{ [x: string]: { address: string } }>> {
    const resolvedConfigMap = objMap(configMap, (_, config) => ({
      gas: gasOverhead(config.type),
      ...config,
    }));

    let result: ChainMap<{ [x: string]: { address: string } }> = {};
    let token_id = '';

    for (const chain of Object.keys(resolvedConfigMap)) {
      const config = resolvedConfigMap[chain];

      switch (config.type) {
        case TokenType.collateral: {
          const { response: collateralToken } = await this.signersMap[
            chain
          ].createCollateralToken({
            origin_mailbox: config.mailbox,
            origin_denom: config.token,
          });
          token_id = collateralToken.id;
          result[chain] = {
            [TokenType.collateral]: {
              address: collateralToken.id,
            },
          };
          break;
        }
        case TokenType.synthetic: {
          const { response: syntheticToken } = await this.signersMap[
            chain
          ].createSyntheticToken({
            origin_mailbox: config.mailbox,
          });
          token_id = syntheticToken.id;
          result[chain] = {
            [TokenType.synthetic]: {
              address: syntheticToken.id,
            },
          };
          break;
        }
        default: {
          throw new Error(`Token type ${config.type} not supported`);
        }
      }

      for (const domainId of Object.keys(config.remoteRouters || {})) {
        assert(config.remoteRouters, ``);

        await this.signersMap[chain].enrollRemoteRouter({
          token_id,
          remote_router: {
            receiver_domain: parseInt(domainId),
            receiver_contract: (config.remoteRouters || {})[domainId].address,
            gas: (config.destinationGas || {})[domainId] ?? '0',
          },
        });
      }
    }

    return result;
  }
}
