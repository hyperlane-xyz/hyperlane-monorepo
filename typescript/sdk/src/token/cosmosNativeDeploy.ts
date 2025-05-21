import { Logger } from 'pino';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { objFilter, objMap, objMerge, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class CosmosNativeDeployer {
  protected logger: Logger;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly signersMap: ChainMap<SigningHyperlaneModuleClient>,
  ) {
    this.logger = rootLogger.child({ module: 'deployer' });
  }

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

    const allChains = Object.keys(
      objMerge(configMap, nonCosmosNativeConfigMap),
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      const config = configMapToDeploy[chain];
      this.logger.info(
        `Deploying ${config.type} token to Cosmos Native chain ${chain}`,
      );

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

      const allRemoteChains = this.multiProvider
        .getRemoteChains(chain)
        .filter((c) => allChains.includes(c));

      const { remote_routers } = await this.signersMap[
        chain
      ].query.warp.RemoteRouters({ id: token_id });

      for (const remote of allRemoteChains) {
        const remoteDomain = this.multiProvider.getDomainId(remote);
        const isRouteAlreadyDeployed = remote_routers.some(
          (r) => r.receiver_domain === remoteDomain,
        );

        // only enroll routes which are not enrolled yet
        if (isRouteAlreadyDeployed) {
          this.logger.info(
            `Router for remote domain already enrolled ${remoteDomain}`,
          );
          continue;
        }

        this.logger.info(`Enrolling remote router for domain ${remoteDomain}`);
        await this.signersMap[chain].enrollRemoteRouter({
          token_id,
          remote_router: {
            receiver_domain: remoteDomain,
            receiver_contract: token_id,
            gas: '0',
          },
        });
      }
    }

    return result;
  }
}
