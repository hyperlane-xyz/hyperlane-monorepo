import { Logger } from 'pino';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { Address, objFilter, objMap, rootLogger } from '@hyperlane-xyz/utils';

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
  ): Promise<ChainMap<Address>> {
    const resolvedConfigMap = objMap(configMap, (_, config) => ({
      gas: gasOverhead(config.type),
      ...config,
    }));

    const result: ChainMap<Address> = {};

    const configMapToDeploy = objFilter(
      resolvedConfigMap,
      (_, config: any): config is any => !config.foreignDeployment,
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      const config = configMapToDeploy[chain];
      this.logger.info(
        `Deploying ${config.type} token to Cosmos Native chain ${chain}`,
      );

      switch (config.type) {
        case TokenType.collateral: {
          this.logger.info(`Deploying collateral token to ${chain}`);
          const { response: collateralToken } = await this.signersMap[
            chain
          ].createCollateralToken({
            origin_mailbox: config.mailbox,
            origin_denom: config.token,
          });
          result[chain] = collateralToken.id;
          break;
        }
        case TokenType.synthetic: {
          this.logger.info(`Deploying synthetic token to ${chain}`);
          const { response: syntheticToken } = await this.signersMap[
            chain
          ].createSyntheticToken({
            origin_mailbox: config.mailbox,
          });
          result[chain] = syntheticToken.id;
          break;
        }
        default: {
          throw new Error(`Token type ${config.type} not supported`);
        }
      }

      this.logger.info(`Successfully deployed contracts on ${chain}`);
    }

    return result;
  }
}
