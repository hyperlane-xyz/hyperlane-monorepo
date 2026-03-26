import {
  BaseFee,
  CrossCollateralRoutingFee,
  RoutingFee,
} from '@hyperlane-xyz/core';
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
  CrossCollateralRoutingFeeConfig,
  OnchainTokenFeeType,
  RoutingFeeConfig,
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
  onChainTypeToTokenFeeTypeMap,
} from './types.js';

type RoutingFeeDeploymentResult = {
  routingFee: RoutingFee | CrossCollateralRoutingFee;
  // Flat list of deployed child fees. The routing contract itself stores the
  // destination/router mapping; deployContracts only needs the concrete child
  // instances so it can expose them by type in the returned contract map.
  childFeeContracts: BaseFee[];
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
        for (const contract of routingFeeResult.childFeeContracts) {
          const onchainFeeType: OnchainTokenFeeType = await contract.feeType();
          const feeType = onChainTypeToTokenFeeTypeMap[onchainFeeType];
          deployedContract[feeType] = contract;
        }
        break;
      }
      case TokenFeeType.CrossCollateralRoutingFee: {
        const routingFeeResult = await this.deployCrossCollateralRoutingFee(
          chain,
          parsedConfig,
        );
        deployedContract[TokenFeeType.CrossCollateralRoutingFee] =
          routingFeeResult.routingFee;
        for (const contract of routingFeeResult.childFeeContracts) {
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
    config: Exclude<
      TokenFeeConfig,
      | { type: TokenFeeType.RoutingFee }
      | { type: TokenFeeType.CrossCollateralRoutingFee }
    >,
  ): Promise<BaseFee> {
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
    config: RoutingFeeConfig,
  ): Promise<RoutingFeeDeploymentResult> {
    const signerAddress = await this.multiProvider.getSignerAddress(chain);

    // RoutingFee.setFeeContract is onlyOwner, so we deploy with the signer as a
    // temporary owner to allow setup, then transfer to the configured owner.
    const routingFee = await this.deployContract(
      chain,
      TokenFeeType.RoutingFee,
      [config.token, signerAddress],
    );

    const childFeeContracts: BaseFee[] = [];
    // Deploy each fee contract & set each fee for the routing fee
    for (const [destinationChain, feeConfig] of Object.entries(
      config.feeContracts,
    )) {
      const deployedFeeContract = await this.deployFee(chain, feeConfig);

      await this.multiProvider.handleTx(
        chain,
        routingFee.setFeeContract(
          this.multiProvider.getDomainId(destinationChain),
          deployedFeeContract.address,
          this.multiProvider.getTransactionOverrides(chain),
        ),
      );
      childFeeContracts.push(deployedFeeContract);
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
      childFeeContracts,
    };
  }

  private async deployCrossCollateralRoutingFee(
    chain: ChainName,
    config: CrossCollateralRoutingFeeConfig,
  ): Promise<RoutingFeeDeploymentResult> {
    const signerAddress = await this.multiProvider.getSignerAddress(chain);
    const routingFee = await this.deployContract(
      chain,
      TokenFeeType.CrossCollateralRoutingFee,
      [signerAddress],
    );

    const childFeeContracts: BaseFee[] = [];
    const destinationDomains: number[] = [];
    const routerKeys: string[] = [];
    const feeAddresses: string[] = [];

    // CCRF stores both destination defaults and router-specific overrides in
    // the same on-chain table. `DEFAULT_ROUTER()` is the sentinel key for the
    // destination-level fallback fee, while `routers[...]` holds per-router
    // overrides for that same destination.
    const defaultRouterKey = await routingFee.DEFAULT_ROUTER();
    for (const [destinationChain, destinationConfig] of Object.entries(
      config.feeContracts,
    )) {
      if (destinationConfig.default) {
        const deployedFeeContract = await this.deployFee(
          chain,
          destinationConfig.default,
        );
        destinationDomains.push(
          this.multiProvider.getDomainId(destinationChain),
        );
        routerKeys.push(defaultRouterKey);
        feeAddresses.push(deployedFeeContract.address);
        childFeeContracts.push(deployedFeeContract);
      }

      for (const [routerKey, routerFeeConfig] of Object.entries(
        destinationConfig.routers ?? {},
      )) {
        const deployedFeeContract = await this.deployFee(
          chain,
          routerFeeConfig,
        );
        destinationDomains.push(
          this.multiProvider.getDomainId(destinationChain),
        );
        routerKeys.push(routerKey);
        feeAddresses.push(deployedFeeContract.address);
        childFeeContracts.push(deployedFeeContract);
      }
    }

    if (destinationDomains.length > 0) {
      await this.multiProvider.handleTx(
        chain,
        routingFee.setCrossCollateralRouterFeeContracts(
          destinationDomains,
          routerKeys,
          feeAddresses,
          this.multiProvider.getTransactionOverrides(chain),
        ),
      );
    }

    if (!eqAddress(signerAddress, config.owner)) {
      this.logger.debug(
        `Transferring ownership of CrossCollateralRoutingFee to ${config.owner} on ${chain}`,
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
      childFeeContracts,
    };
  }
}
