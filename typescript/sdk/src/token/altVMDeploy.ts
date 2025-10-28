import { Logger } from 'pino';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx } from '@hyperlane-xyz/provider-sdk/module';
import {
  Address,
  assert,
  objFilter,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ProtocolReceipt } from '../providers/ProviderType.js';
import { ChainMap, ChainName } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import { WarpRouteDeployConfigMailboxRequired } from './types.js';

export class AltVMDeployer<PT extends ProtocolType> {
  protected logger: Logger;

  constructor(
    protected readonly signersMap: ChainMap<
      AltVM.ISigner<AnnotatedTx, ProtocolReceipt<PT>>
    >,
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

    type Config = WarpRouteDeployConfigMailboxRequired[string];
    const configMapToDeploy = objFilter(
      resolvedConfigMap,
      (_: string, cfg: Config): cfg is Config => !cfg.foreignDeployment,
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

      if (
        config.interchainSecurityModule &&
        typeof config.interchainSecurityModule === 'string'
      ) {
        this.logger.info(`Set ISM for token`);

        await this.signersMap[chain].setTokenIsm({
          tokenAddress: result[chain],
          ismAddress: config.interchainSecurityModule,
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
    const { tokenAddress } = await this.signersMap[chain].createCollateralToken(
      {
        mailboxAddress: originMailbox,
        collateralDenom: originDenom,
      },
    );
    return tokenAddress;
  }

  private async deploySyntheticToken(
    chain: ChainName,
    originMailbox: Address,
    name: string | undefined,
    denom: string | undefined,
    decimals: number | undefined,
  ): Promise<Address> {
    this.logger.info(`Deploying synthetic token to ${chain}`);
    const { tokenAddress } = await this.signersMap[chain].createSyntheticToken({
      mailboxAddress: originMailbox,
      name: name || '',
      denom: denom || '',
      decimals: decimals || 0,
    });
    return tokenAddress;
  }
}
