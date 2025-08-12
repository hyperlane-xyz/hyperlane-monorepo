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
    let deployedContract = {};

    switch (config.type) {
      case TokenFeeType.LinearFee:
      case TokenFeeType.ProgressiveFee:
      case TokenFeeType.RegressiveFee:
        deployedContract = await this.deployFee(config.type, chain, config);
        break;
      case TokenFeeType.RoutingFee:
        deployedContract = await this.deployRoutingFee(chain, config);
        break;
    }
    return { [config.type]: deployedContract } as any; // Returns a partial HyperlaneContracts<EvmTokenFeeFactories>
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
