import { ethers } from 'ethers';

import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  TokenBridgeRouter,
  TokenBridgeRouter__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import {
  TokenBridgeContracts,
  TokenBridgeFactories,
  tokenBridgeFactories,
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

export type TokenBridgeConfig = RouterConfig & {
  bridgeAdapterConfigs: BridgeAdapterConfig[];
};

export class TokenBridgeDeployer<
  Chain extends ChainName,
> extends HyperlaneRouterDeployer<
  Chain,
  TokenBridgeConfig,
  TokenBridgeContracts,
  TokenBridgeFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, TokenBridgeConfig>,
    protected core: HyperlaneCore<Chain>,
    protected create2salt = 'TokenBridgeDeployerSalt',
  ) {
    super(multiProvider, configMap, tokenBridgeFactories, {});
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, TokenBridgeContracts>,
  ): Promise<void> {
    // Enroll the TokenBridgeRouter with each other
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
    config: TokenBridgeConfig,
  ): Promise<TokenBridgeContracts> {
    const initCalldata =
      TokenBridgeRouter__factory.createInterface().encodeFunctionData(
        'initialize',
        [config.owner, config.connectionManager, config.interchainGasPaymaster],
      );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt,
      initCalldata,
    });

    const bridgeAdapters: Partial<TokenBridgeContracts> = {};

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
    router: TokenBridgeRouter,
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

    this.logger('Set CircleTokenBridgeAdapter on Router');
    await cc.handleTx(
      router.setTokenBridgeAdapter(
        adapterConfig.type,
        circleBridgeAdapter.address,
      ),
    );
    return circleBridgeAdapter;
  }
}
