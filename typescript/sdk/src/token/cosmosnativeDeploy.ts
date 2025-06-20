import { Logger } from 'pino';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  ProtocolType,
  assert,
  objFilter,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { ChainMap, ChainName } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class CosmosNativeDeployer {
  protected logger: Logger;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly signersMap: ChainMap<SigningHyperlaneModuleClient>,
  ) {
    this.logger = rootLogger.child({ module: 'CosmosNativeDeployer' });
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
      (chain: string, config: any): config is any =>
        this.metadataManager.getProtocol(chain) === ProtocolType.CosmosNative &&
        !config.foreignDeployment,
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      assert(this.signersMap[chain], `No signer configured for ${chain}`);

      const config = configMapToDeploy[chain];
      assert(this.signersMap[chain], `No config configured for ${chain}`);

      this.logger.info(
        `Deploying ${config.type} token to Cosmos Native chain ${chain}`,
      );

      switch (config.type) {
        case TokenType.collateral: {
          result[chain] = await this.deployCollateralToken(
            chain,
            config.mailbox,
            config.token,
          );
          break;
        }
        case TokenType.synthetic: {
          result[chain] = await this.deploySyntheticToken(
            chain,
            config.mailbox,
          );
          break;
        }
        default: {
          throw new Error(
            `Token type ${config.type} not supported on chain ${chain}`,
          );
        }
      }

      this.logger.info(`Successfully deployed contracts on ${chain}`);
    }

    return result;
  }

  private async deployCollateralToken(
    chain: ChainName,
    originMailbox: Address,
    originDenom: string,
  ): Promise<Address> {
    this.logger.info(`Deploying collateral token to ${chain}`);
    const { response } = await this.signersMap[chain].createCollateralToken({
      origin_mailbox: originMailbox,
      origin_denom: originDenom,
    });
    return response.id;
  }

  private async deploySyntheticToken(
    chain: ChainName,
    originMailbox: Address,
  ): Promise<Address> {
    this.logger.info(`Deploying synthetic token to ${chain}`);
    const { response } = await this.signersMap[chain].createSyntheticToken({
      origin_mailbox: originMailbox,
    });
    return response.id;
  }
}
