import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter,
  PortalAdapter,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { ChainNameToDomainId } from '../../domains';
import {
  LiquidityLayerContracts,
  LiquidityLayerFactories,
  liquidityLayerFactories,
} from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { objFilter, objMap } from '../../utils/objects';
import { RouterConfig } from '../router/types';

import { MiddlewareRouterDeployer } from './deploy';

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

export class LiquidityLayerDeployer<
  Chain extends ChainName,
> extends MiddlewareRouterDeployer<
  Chain,
  LiquidityLayerConfig,
  LiquidityLayerContracts,
  LiquidityLayerFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, LiquidityLayerConfig>,
    create2salt = 'liquiditylayerrouter',
  ) {
    super(multiProvider, configMap, liquidityLayerFactories, create2salt);
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, LiquidityLayerContracts>,
  ): Promise<void> {
    this.logger(`Enroll LiquidityLayerRouters with each other`);
    await super.enrollRemoteRouters(contractsMap);

    this.logger(`Enroll CircleBridgeAdapters with each other`);
    await super.enrollRemoteRouters(
      objFilter(
        objMap(contractsMap, (_chain, contracts) => ({
          router: contracts.circleBridgeAdapter,
        })),
        (_): _ is { router: CircleBridgeAdapter } => !!_.router,
      ),
    );

    this.logger(`Enroll PortalAdapters with each other`);
    await super.enrollRemoteRouters(
      objFilter(
        objMap(contractsMap, (_chain, contracts) => ({
          router: contracts.portalAdapter,
        })),
        (_): _ is { router: PortalAdapter } => !!_.router,
      ),
    );
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: Chain,
    config: LiquidityLayerConfig,
  ): Promise<LiquidityLayerContracts> {
    const routerContracts = await super.deployContracts(chain, config);

    const bridgeAdapters: Partial<LiquidityLayerContracts> = {};

    if (config.circle) {
      bridgeAdapters.circleBridgeAdapter = await this.deployCircleBridgeAdapter(
        chain,
        config.circle,
        config.owner,
        routerContracts.router,
      );
    }
    if (config.portal) {
      bridgeAdapters.portalAdapter = await this.deployPortalAdapter(
        chain,
        config.portal,
        config.owner,
        routerContracts.router,
      );
    }

    return {
      ...routerContracts,
      ...bridgeAdapters,
    } as any;
  }

  async deployPortalAdapter(
    chain: Chain,
    adapterConfig: PortalAdapterConfig,
    owner: string,
    router: LiquidityLayerRouter,
  ): Promise<PortalAdapter> {
    const cc = this.multiProvider.getChainConnection(chain);

    const initCalldata =
      PortalAdapter__factory.createInterface().encodeFunctionData(
        'initialize',
        [
          ChainNameToDomainId[chain],
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
      await cc.handleTx(
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
      await cc.handleTx(
        router.setLiquidityLayerAdapter(
          adapterConfig.type,
          portalAdapter.address,
        ),
      );
    }

    return portalAdapter;
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

    if (
      !utils.eqAddress(
        await router.liquidityLayerAdapters('Circle'),
        circleBridgeAdapter.address,
      )
    ) {
      this.logger('Set Circle as LiquidityLayerAdapter on Router');
      await cc.handleTx(
        router.setLiquidityLayerAdapter(
          adapterConfig.type,
          circleBridgeAdapter.address,
        ),
      );
    }

    return circleBridgeAdapter;
  }
}
