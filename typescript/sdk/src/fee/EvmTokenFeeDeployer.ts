import { BaseFee, RoutingFee } from '@hyperlane-xyz/core';

import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer.js';
import { HyperlaneContracts, MultiProvider } from '../index.js';
import { ChainName } from '../types.js';

import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories, evmTokenFeeFactories } from './contracts.js';
import {
  OnchainTokenFeeType,
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
  onChainTypeToTokenFeeTypeMap,
} from './types.js';

type RoutingFeeDeploymentResult = {
  routingFee: RoutingFee;
  subFeeContracts: Record<ChainName, BaseFee>;
};

export class EvmTokenFeeDeployer extends HyperlaneDeployer<
  TokenFeeConfigInput,
  EvmTokenFeeFactories
> {
  protected readonly tokenFeeReader: EvmTokenFeeReader;
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainName,
    options: DeployerOptions = {},
  ) {
    super(multiProvider, evmTokenFeeFactories, options);
    this.tokenFeeReader = new EvmTokenFeeReader(multiProvider, chain);
  }
  async deployContracts(
    chain: ChainName,
    config: TokenFeeConfigInput,
  ): Promise<HyperlaneContracts<EvmTokenFeeFactories>> {
    const deployedContract: any = {}; // This is a partial HyperlaneContracts<EvmTokenFeeFactories>

    switch (config.type) {
      case TokenFeeType.LinearFee:
      case TokenFeeType.ProgressiveFee:
      case TokenFeeType.RegressiveFee:
        deployedContract[config.type] = await this.deployFee(
          config.type,
          chain,
          config,
        );
        break;
      case TokenFeeType.RoutingFee: {
        // Return the routing fee and all the child fee contracts
        const routingFeeResult = await this.deployRoutingFee(chain, config);
        deployedContract[TokenFeeType.RoutingFee] = routingFeeResult.routingFee;
        for (const [_, contract] of Object.entries(
          routingFeeResult.subFeeContracts,
        )) {
          const onchainFeeType: OnchainTokenFeeType = await contract.feeType();
          const feeType = onChainTypeToTokenFeeTypeMap[onchainFeeType];
          deployedContract[feeType] = contract;
        }
        break;
      }
    }
    return deployedContract;
  }

  private async deployFee(
    feeType: TokenFeeType,
    chain: ChainName,
    config: TokenFeeConfigInput,
  ): Promise<ReturnType<EvmTokenFeeFactories[typeof feeType]['deploy']>> {
    const parsedConfig = TokenFeeConfigSchema.parse(config);

    let { maxFee, halfAmount } = parsedConfig;
    if (config.bps) {
      const { maxFee: calculatedMaxFee, halfAmount: calculatedHalfAmount } =
        await this.tokenFeeReader.convertFromBps(
          parsedConfig.bps.toString(),
          config.token,
        );
      maxFee = calculatedMaxFee;
      halfAmount = calculatedHalfAmount;
    }
    return this.deployContract(chain, feeType, [
      config.token,
      maxFee,
      halfAmount,
      parsedConfig.owner,
    ]);
  }

  private async deployRoutingFee(
    chain: ChainName,
    config: TokenFeeConfigInput,
  ): Promise<RoutingFeeDeploymentResult> {
    if (config.type !== TokenFeeType.RoutingFee) {
      throw new Error('Invalid config type for routing fee deployment');
    }

    // Deploy the routing fee contract
    const routingFee = await this.deployContract(
      chain,
      TokenFeeType.RoutingFee,
      [config.token, config.owner],
    );

    const subFeeContracts: Record<ChainName, BaseFee> = {};
    if (config.feeContracts) {
      // Deploy each fee contract & set each fee for the routing fee
      for (const [destinationChain, feeConfig] of Object.entries(
        config.feeContracts,
      )) {
        const deployedFeeContract = await this.deployFee(
          feeConfig.type,
          chain,
          feeConfig,
        );

        await routingFee.setFeeContract(
          this.multiProvider.getChainId(destinationChain),
          deployedFeeContract.address,
        );
        subFeeContracts[destinationChain] = deployedFeeContract;
      }
    }

    return {
      routingFee,
      subFeeContracts,
    };
  }
}
