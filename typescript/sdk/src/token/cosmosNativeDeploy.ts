import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { assert, objFilter, objMap, objMerge } from '@hyperlane-xyz/utils';

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
    nonCosmosNativeConfigMap: WarpRouteDeployConfigMailboxRequired,
  ): Promise<ChainMap<{ [x: string]: { address: string } }>> {
    const resolvedConfigMap = objMap(configMap, (_, config) => ({
      gas: gasOverhead(config.type),
      ...config,
    }));

    let result: ChainMap<{ [x: string]: { address: string } }> = {};
    let token_id = '';

    const configMapToDeploy = objFilter(
      resolvedConfigMap,
      (_, config: any): config is any => !config.foreignDeployment,
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      const config = configMapToDeploy[chain];

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

    const allChains = Object.keys(
      objMerge(configMap, nonCosmosNativeConfigMap),
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      const allRemoteChains = this.multiProvider
        .getRemoteChains(chain)
        .filter((c) => allChains.includes(c));

      const { remote_routers } = await this.signersMap[
        chain
      ].query.warp.RemoteRouters({ id: '' });

      const enrollEntries = await Promise.all(
        allRemoteChains.map(async (remote) => {
          const remoteDomain = this.multiProvider.getDomainId(remote);
          const current = await this.router(contracts).routers(remoteDomain);
          const expected = addressToBytes32(allRouters[remote]);
          return current !== expected ? [remoteDomain, expected] : undefined;
        }),
      );
    }

    return result;
  }
}
