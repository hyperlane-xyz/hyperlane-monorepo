import { BaseFee, RoutingFee } from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import type { HyperlaneContracts } from '../contracts/types.js';
import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories, evmTokenFeeFactories } from './contracts.js';
import {
  OnchainTokenFeeType,
  TokenFeeConfig,
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
        this.tokenFeeReader.convertFromBps(config.bps);
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

    const signerAddress = await this.multiProvider.getSignerAddress(chain);

    // RoutingFee.setFeeContract is onlyOwner, so we deploy with the signer as a
    // temporary owner to allow setup, then transfer to the configured owner.
    const routingFee = await this.deployContract(
      chain,
      TokenFeeType.RoutingFee,
      [config.token, signerAddress],
    );

    const subFeeContracts: Record<ChainName, BaseFee> = {};
    if (config.feeContracts) {
      // Deploy each fee contract & set each fee for the routing fee
      for (const [destinationChain, feeConfig] of Object.entries(
        config.feeContracts,
      )) {
        const deployedFeeContract = await this.deployFee(chain, feeConfig);

        await this.multiProvider.handleTx(
          chain,
          routingFee.setFeeContract(
            this.multiProvider.getChainId(destinationChain),
            deployedFeeContract.address,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        );
        subFeeContracts[destinationChain] = deployedFeeContract;
      }
    }

    if (!eqAddress(signerAddress, config.owner)) {
      this.logger.debug(
        `Transferring ownership of RoutingFee to ${config.owner} on ${chain}`,
      );
      await this.multiProvider.handleTx(
        chain,
        routingFee.transferOwnership(
          config.owner,
          this.multiProvider.getTransactionOverrides(chain),
        ),
      );
    }

    return {
      routingFee,
      subFeeContracts,
    };
  }
}
