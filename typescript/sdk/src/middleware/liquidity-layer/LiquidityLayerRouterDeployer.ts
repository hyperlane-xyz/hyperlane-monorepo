import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter,
  LiquidityLayerRouter__factory,
  PortalAdapter,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { objMap } from '../../utils/objects';
import { MiddlewareRouterDeployer } from '../MiddlewareRouterDeployer';

import {
  LiquidityLayerContracts,
  LiquidityLayerFactories,
  liquidityLayerFactories,
} from './contracts';

export enum BridgeAdapterType {
  Circle = 'Circle',
  Portal = 'Portal',
}

export interface CircleBridgeAdapterConfig {
  type: BridgeAdapterType.Circle;
  tokenMessengerAddress: string;
  messageTransmitterAddress: string;
  usdcAddress: string;
  circleDomainMapping: {
    hyperlaneDomain: number;
    circleDomain: number;
  }[];
}

export interface PortalAdapterConfig {
  type: BridgeAdapterType.Portal;
  portalBridgeAddress: string;
  wormholeDomainMapping: {
    hyperlaneDomain: number;
    wormholeDomain: number;
  }[];
}

export type BridgeAdapterConfig = {
  circle?: CircleBridgeAdapterConfig;
  portal?: PortalAdapterConfig;
};

export type LiquidityLayerConfig = RouterConfig & BridgeAdapterConfig;

export class LiquidityLayerDeployer extends MiddlewareRouterDeployer<
  LiquidityLayerConfig,
  LiquidityLayerContracts,
  LiquidityLayerFactories,
  LiquidityLayerRouter__factory
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<LiquidityLayerConfig>,
    create2salt = 'LiquidityLayerDeployerSalt',
  ) {
    super(multiProvider, configMap, liquidityLayerFactories, create2salt);
  }

  routerContractName(): string {
    return 'liquidityLayerRouter';
  }

  router(contracts: LiquidityLayerContracts) {
    return contracts.liquidityLayerRouter.contract;
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<LiquidityLayerContracts>,
  ): Promise<void> {
    this.logger(`Enroll LiquidityLayerRouters with each other`);
    await super.enrollRemoteRouters(contractsMap);

    this.logger(`Enroll CircleBridgeAdapters with each other`);
    // Hack to allow use of super.enrollRemoteRouters
    await super.enrollRemoteRouters(
      objMap(contractsMap, (_, contracts) => ({
        liquidityLayerRouter: {
          contract: contracts.circleBridgeAdapter,
        },
      })) as unknown as ChainMap<LiquidityLayerContracts>,
    );

    this.logger(`Enroll PortalAdapters with each other`);
    // Hack to allow use of super.enrollRemoteRouters
    await super.enrollRemoteRouters(
      objMap(contractsMap, (_, contracts) => ({
        liquidityLayerRouter: {
          contract: contracts.portalAdapter,
        },
      })) as unknown as ChainMap<LiquidityLayerContracts>,
    );
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: ChainName,
    config: LiquidityLayerConfig,
  ): Promise<LiquidityLayerContracts> {
    const routerContracts = (await super.deployContracts(
      chain,
      config,
    )) as LiquidityLayerContracts;

    const bridgeAdapters: Partial<LiquidityLayerContracts> = {};

    if (config.circle) {
      bridgeAdapters.circleBridgeAdapter = await this.deployCircleBridgeAdapter(
        chain,
        config.circle,
        config.owner,
        routerContracts.liquidityLayerRouter.contract,
      );
    }
    if (config.portal) {
      bridgeAdapters.portalAdapter = await this.deployPortalAdapter(
        chain,
        config.portal,
        config.owner,
        routerContracts.liquidityLayerRouter.contract,
      );
    }

    return {
      ...routerContracts,
      ...bridgeAdapters,
    } as LiquidityLayerContracts;
  }

  async deployPortalAdapter(
    chain: ChainName,
    adapterConfig: PortalAdapterConfig,
    owner: string,
    router: LiquidityLayerRouter,
  ): Promise<PortalAdapter> {
    const initCalldata =
      PortalAdapter__factory.createInterface().encodeFunctionData(
        'initialize',
        [
          this.multiProvider.getDomainId(chain),
          owner,
          adapterConfig.portalBridgeAddress,
          router.address,
        ],
      );
    const portalAdapter = await this.deployContract(
      chain,
      'portalAdapter',
      [],
      {
        create2Salt: this.create2salt,
        initCalldata,
      },
    );

    for (const {
      wormholeDomain,
      hyperlaneDomain,
    } of adapterConfig.wormholeDomainMapping) {
      const expectedCircleDomain =
        await portalAdapter.hyperlaneDomainToWormholeDomain(hyperlaneDomain);
      if (expectedCircleDomain === wormholeDomain) continue;

      this.logger(
        `Set wormhole domain ${wormholeDomain} for hyperlane domain ${hyperlaneDomain}`,
      );
      await this.multiProvider.handleTx(
        chain,
        portalAdapter.addDomain(hyperlaneDomain, wormholeDomain),
      );
    }

    if (
      !utils.eqAddress(
        await router.liquidityLayerAdapters('Portal'),
        portalAdapter.address,
      )
    ) {
      this.logger('Set Portal as LiquidityLayerAdapter on Router');
      await this.multiProvider.handleTx(
        chain,
        router.setLiquidityLayerAdapter(
          adapterConfig.type,
          portalAdapter.address,
        ),
      );
    }

    return portalAdapter;
  }

  async deployCircleBridgeAdapter(
    chain: ChainName,
    adapterConfig: CircleBridgeAdapterConfig,
    owner: string,
    router: LiquidityLayerRouter,
  ): Promise<CircleBridgeAdapter> {
    const initCalldata =
      CircleBridgeAdapter__factory.createInterface().encodeFunctionData(
        'initialize',
        [
          owner,
          adapterConfig.tokenMessengerAddress,
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
      !utils.eqAddress(
        await circleBridgeAdapter.tokenSymbolToAddress('USDC'),
        adapterConfig.usdcAddress,
      )
    ) {
      this.logger(`Set USDC token contract`);
      await this.multiProvider.handleTx(
        chain,
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
      await this.multiProvider.handleTx(
        chain,
        circleBridgeAdapter.addDomain(hyperlaneDomain, circleDomain),
      );
    }

    if (
      !utils.eqAddress(
        await router.liquidityLayerAdapters('Circle'),
        circleBridgeAdapter.address,
      )
    ) {
      this.logger('Set Circle as LiquidityLayerAdapter on Router');
      await this.multiProvider.handleTx(
        chain,
        router.setLiquidityLayerAdapter(
          adapterConfig.type,
          circleBridgeAdapter.address,
        ),
      );
    }

    return circleBridgeAdapter;
  }
}
