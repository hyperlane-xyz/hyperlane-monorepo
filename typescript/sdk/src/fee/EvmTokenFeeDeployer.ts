import {
  LinearFee,
  ProgressiveFee,
  RegressiveFee,
  RoutingFee,
} from '@hyperlane-xyz/core';

import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { HyperlaneContracts } from '../index.js';
import { ChainName } from '../types.js';

import { EvmTokenFeeFactories } from './contracts.js';
import { TokenFee, TokenFeeType } from './types.js';

export class EvmTokenFeeDeployer extends HyperlaneDeployer<
  TokenFee,
  EvmTokenFeeFactories
> {
  async deployContracts(
    chain: ChainName,
    config: TokenFee,
  ): Promise<HyperlaneContracts<EvmTokenFeeFactories>> {
    let deployedContract;
    switch (config.type) {
      case TokenFeeType.LinearFee:
        deployedContract = await this.deployLinearFee(chain, config);
        break;
      case TokenFeeType.ProgressiveFee:
        deployedContract = await this.deployProgressiveFee(chain, config);
        break;
      case TokenFeeType.RegressiveFee:
        deployedContract = await this.deployRegressiveFee(chain, config);
        break;
      case TokenFeeType.RoutingFee:
        deployedContract = await this.deployRoutingFee(chain, config);
        break;
    }
    return { [config.type]: deployedContract } as any; // partial
  }

  private async deployLinearFee(
    chain: ChainName,
    config: TokenFee,
  ): Promise<LinearFee> {
    return this.deployContract(chain, TokenFeeType.LinearFee, [
      config.token,
      config.maxFee,
      config.halfAmount,
      config.owner,
    ]);
  }

  private async deployProgressiveFee(
    chain: ChainName,
    config: TokenFee,
  ): Promise<ProgressiveFee> {
    return this.deployContract(chain, TokenFeeType.ProgressiveFee, [
      config.token,
      config.maxFee,
      config.halfAmount,
      config.owner,
    ]);
  }

  private async deployRegressiveFee(
    chain: ChainName,
    config: TokenFee,
  ): Promise<RegressiveFee> {
    return this.deployContract(chain, TokenFeeType.RegressiveFee, [
      config.token,
      config.maxFee,
      config.halfAmount,
      config.owner,
    ]);
  }

  private async deployRoutingFee(
    chain: ChainName,
    config: TokenFee,
  ): Promise<RoutingFee> {
    return this.deployContract(chain, TokenFeeType.RoutingFee, [
      config.token,
      config.owner,
    ]);
  }
}
