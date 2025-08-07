import { RoutingFee } from '@hyperlane-xyz/core';

import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { HyperlaneContracts } from '../index.js';
import { ChainName } from '../types.js';

import { EvmTokenFeeFactories } from './contracts.js';
import { TokenFeeConfig, TokenFeeType } from './types.js';

export class EvmTokenFeeDeployer extends HyperlaneDeployer<
  TokenFeeConfig,
  EvmTokenFeeFactories
> {
  async deployContracts(
    chain: ChainName,
    config: TokenFeeConfig,
  ): Promise<HyperlaneContracts<EvmTokenFeeFactories>> {
    let deployedContract;
    switch (config.type) {
      case TokenFeeType.LinearFee:
        deployedContract = await this.deployFee(
          TokenFeeType.LinearFee,
          chain,
          config,
        );
        break;
      case TokenFeeType.ProgressiveFee:
        deployedContract = await this.deployFee(
          TokenFeeType.ProgressiveFee,
          chain,
          config,
        );
        break;
      case TokenFeeType.RegressiveFee:
        deployedContract = await this.deployFee(
          TokenFeeType.RegressiveFee,
          chain,
          config,
        );
        break;
      case TokenFeeType.RoutingFee:
        deployedContract = await this.deployRoutingFee(chain, config);
        break;
    }
    return { [config.type]: deployedContract } as any; // partial
  }

  async deployFee(
    feeType: TokenFeeType,
    chain: ChainName,
    config: TokenFeeConfig,
  ): Promise<ReturnType<EvmTokenFeeFactories[typeof feeType]['deploy']>> {
    return this.deployContract(chain, feeType, [
      config.token,
      config.maxFee,
      config.halfAmount,
      config.owner,
    ]);
  }

  private async deployRoutingFee(
    chain: ChainName,
    config: TokenFeeConfig,
  ): Promise<RoutingFee> {
    return this.deployContract(chain, TokenFeeType.RoutingFee, [
      config.token,
      config.owner,
    ]);
  }
}
