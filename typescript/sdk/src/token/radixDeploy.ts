import { Logger } from 'pino';

import { RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
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

export class RadixDeployer {
  protected logger: Logger;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly signersMap: ChainMap<RadixSigningSDK>,
  ) {
    this.logger = rootLogger.child({ module: 'RadixDeployer' });
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
        this.metadataManager.getProtocol(chain) === ProtocolType.Radix &&
        !config.foreignDeployment,
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      assert(this.signersMap[chain], `No signer configured for ${chain}`);

      const config = configMapToDeploy[chain];
      assert(this.signersMap[chain], `No config configured for ${chain}`);

      this.logger.info(
        `Deploying ${config.type} token to Radix chain ${chain}`,
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
            config.name,
            config.symbol,
            config.decimals,
          );
          break;
        }
        default: {
          throw new Error(
            `Token type ${config.type} not supported on chain ${chain}`,
          );
        }
      }

      // TODO: RADIX
      // update owner at the end or else remote router txs will fail
      if (this.signersMap[chain].getAddress() !== config.owner) {
        await this.signersMap[chain].tx.setTokenOwner({
          token: result[chain],
          new_owner: config.owner,
        });
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
    return this.signersMap[chain].tx.createCollateralToken({
      mailbox: originMailbox,
      origin_denom: originDenom,
    });
  }

  private async deploySyntheticToken(
    chain: ChainName,
    originMailbox: Address,
    name: string,
    symbol: string,
    divisibility: number,
  ): Promise<Address> {
    this.logger.info(`Deploying synthetic token to ${chain}`);
    return this.signersMap[chain].tx.createSyntheticToken({
      mailbox: originMailbox,
      name,
      symbol,
      description: '',
      divisibility,
    });
  }
}
