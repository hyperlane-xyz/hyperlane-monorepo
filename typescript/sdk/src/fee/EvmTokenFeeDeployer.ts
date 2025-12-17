import { type BaseFee, type RoutingFee } from '@hyperlane-xyz/core';

import {
  type DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer.js';
import { type HyperlaneContracts, type MultiProvider } from '../index.js';
import { type ChainName } from '../types.js';

import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import {
  type EvmTokenFeeFactories,
  evmTokenFeeFactories,
} from './contracts.js';
import {
  type OnchainTokenFeeType,
  type TokenFeeConfig,
  type TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
  onChainTypeToTokenFeeTypeMap,
} from './types.js';

type RoutingFeeDeploymentResult = {
  routingFee: RoutingFee;
  subFeeContracts: Record<ChainName, BaseFee>;
};

export class EvmTokenFeeDeployer extends HyperlaneDeployer<
  TokenFeeConfig,
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
    const parsedConfig = TokenFeeConfigSchema.parse(config);

    switch (parsedConfig.type) {
      case TokenFeeType.LinearFee:
      case TokenFeeType.ProgressiveFee:
      case TokenFeeType.RegressiveFee:
        deployedContract[parsedConfig.type] = await this.deployFee(
          chain,
          parsedConfig,
        );
        break;
      case TokenFeeType.RoutingFee: {
        // Return the routing fee and all the child fee contracts
        const routingFeeResult = await this.deployRoutingFee(
          chain,
          parsedConfig,
        );
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
    chain: ChainName,
    config: Exclude<TokenFeeConfig, { type: TokenFeeType.RoutingFee }>,
  ): Promise<
    ReturnType<EvmTokenFeeFactories[TokenFeeConfig['type']]['deploy']>
  > {
    let { maxFee, halfAmount } = config;
    if (
      config.type === TokenFeeType.LinearFee &&
      config.bps &&
      (!maxFee || !halfAmount)
    ) {
      const { maxFee: calculatedMaxFee, halfAmount: calculatedHalfAmount } =
        await this.tokenFeeReader.convertFromBps(config.bps, config.token);
      maxFee = calculatedMaxFee;
      halfAmount = calculatedHalfAmount;
    }
    return this.deployContract(chain, config.type, [
      config.token,
      maxFee,
      halfAmount,
      config.owner,
    ]);
  }

  private async deployRoutingFee(
    chain: ChainName,
    config: TokenFeeConfig,
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
        const deployedFeeContract = await this.deployFee(chain, feeConfig);

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
