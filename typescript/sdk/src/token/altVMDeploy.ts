import { Logger } from 'pino';

import {
  Address,
  AltVM,
  assert,
  objFilter,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { ChainMap, ChainName } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class AltVMDeployer {
  protected logger: Logger;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly signersMap: ChainMap<AltVM.ISigner>,
  ) {
    this.logger = rootLogger.child({ module: 'AltVMDeployer' });
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
      (_: string, config: any): config is any => !config.foreignDeployment,
    );

    for (const chain of Object.keys(configMapToDeploy)) {
      assert(this.signersMap[chain], `No signer configured for ${chain}`);

      const config = configMapToDeploy[chain];
      assert(config, `No config configured for ${chain}`);

      this.logger.info(`Deploying ${config.type} token to chain ${chain}`);

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

      if (config.interchainSecurityModule) {
        this.logger.info(`Set ISM for token`);

        await this.signersMap[chain].setTokenIsm({
          tokenId: result[chain],
          ismId: config.interchainSecurityModule,
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
    const { tokenId } = await this.signersMap[chain].createCollateralToken({
      mailboxId: originMailbox,
      originDenom: originDenom,
    });
    return tokenId;
  }

  private async deploySyntheticToken(
    chain: ChainName,
    originMailbox: Address,
  ): Promise<Address> {
    this.logger.info(`Deploying synthetic token to ${chain}`);
    const { tokenId } = await this.signersMap[chain].createSyntheticToken({
      mailboxId: originMailbox,
    });
    return tokenId;
  }
}
