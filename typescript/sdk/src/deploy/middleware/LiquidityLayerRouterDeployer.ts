import { ethers } from 'ethers';

import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter,
  LiquidityLayerRouter__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import {
  LiquidityLayerContracts,
  LiquidityLayerFactories,
  liquidityLayerFactories,
} from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { objMap } from '../../utils/objects';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../router/types';

export enum BridgeAdapterType {
  Circle = 'Circle',
}

export interface CircleBridgeAdapterConfig {
  type: BridgeAdapterType.Circle;
  circleBridgeAddress: string;
  messageTransmitterAddress: string;
  usdcAddress: string;
  circleDomainMapping: {
    hyperlaneDomain: number;
    circleDomain: number;
  }[];
}

export type BridgeAdapterConfig = CircleBridgeAdapterConfig;

export type LiquidityLayerConfig = RouterConfig & {
  bridgeAdapterConfigs: BridgeAdapterConfig[];
};

export class LiquidityLayerDeployer<
  Chain extends ChainName,
> extends HyperlaneRouterDeployer<
  Chain,
  LiquidityLayerConfig,
  LiquidityLayerContracts,
  LiquidityLayerFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, LiquidityLayerConfig>,
    protected core: HyperlaneCore<Chain>,
    protected create2salt = 'LiquidityLayerDeployerSalt',
  ) {
    super(multiProvider, configMap, liquidityLayerFactories, {});
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, LiquidityLayerContracts>,
  ): Promise<void> {
    // Enroll the LiquidityLayerRouter with each other
    await super.enrollRemoteRouters(contractsMap);

    // Enroll the circle adapters with each other
    await super.enrollRemoteRouters(
      objMap(contractsMap, (_chain, contracts) => ({
        router: contracts.circleBridgeAdapter!,
      })),
    );
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: Chain,
    config: LiquidityLayerConfig,
  ): Promise<LiquidityLayerContracts> {
    const initCalldata =
      LiquidityLayerRouter__factory.createInterface().encodeFunctionData(
        'initialize',
        [config.owner, config.connectionManager, config.interchainGasPaymaster],
      );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt,
      initCalldata,
    });

    const bridgeAdapters: Partial<LiquidityLayerContracts> = {};

    for (const adapterConfig of config.bridgeAdapterConfigs) {
      if (adapterConfig.type === BridgeAdapterType.Circle) {
        bridgeAdapters.circleBridgeAdapter =
          await this.deployCircleBridgeAdapter(
            chain,
            adapterConfig,
            config.owner,
            router,
          );
      }
    }

    return {
      ...bridgeAdapters,
      router,
    };
  }

  async deployCircleBridgeAdapter(
    chain: Chain,
    adapterConfig: CircleBridgeAdapterConfig,
    owner: string,
    router: LiquidityLayerRouter,
  ): Promise<CircleBridgeAdapter> {
    const cc = this.multiProvider.getChainConnection(chain);
    const initCalldata =
      CircleBridgeAdapter__factory.createInterface().encodeFunctionData(
        'initialize',
        [
          owner,
          adapterConfig.circleBridgeAddress,
          adapterConfig.messageTransmitterAddress,
          router.address,
        ],
      );
    const circleBridgeAdapter = await this.deployContract(
      chain,
      'circleBridgeAdapter',
      [],
      {
        create2Salt: this.create2salt,
        initCalldata,
      },
    );

    if (
      (await circleBridgeAdapter.tokenSymbolToAddress('USDC')) ===
      ethers.constants.AddressZero
    ) {
      this.logger(`Set USDC token contract`);
      await cc.handleTx(
        circleBridgeAdapter.addToken(adapterConfig.usdcAddress, 'USDC'),
      );
    }
    // Set domain mappings
    for (const {
      circleDomain,
      hyperlaneDomain,
    } of adapterConfig.circleDomainMapping) {
      const expectedCircleDomain =
        await circleBridgeAdapter.hyperlaneDomainToCircleDomain(
          hyperlaneDomain,
        );
      if (expectedCircleDomain === circleDomain) continue;

      this.logger(
        `Set circle domain ${circleDomain} for hyperlane domain ${hyperlaneDomain}`,
      );
      await cc.handleTx(
        circleBridgeAdapter.addDomain(hyperlaneDomain, circleDomain),
      );
    }

    this.logger('Set CircleLiquidityLayerAdapter on Router');
    await cc.handleTx(
      router.setLiquidityLayerAdapter(
        adapterConfig.type,
        circleBridgeAdapter.address,
      ),
    );
    return circleBridgeAdapter;
  }
}
