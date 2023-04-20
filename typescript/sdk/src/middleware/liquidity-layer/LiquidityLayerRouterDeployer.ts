import { ethers } from 'ethers';

import {
  CircleBridgeAdapter,
  LiquidityLayerRouter,
  PortalAdapter,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneContractsMap } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { objFilter, objMap } from '../../utils/objects';

import { LiquidityLayerFactories, liquidityLayerFactories } from './contracts';

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

export class LiquidityLayerDeployer extends ProxiedRouterDeployer<
  LiquidityLayerConfig,
  LiquidityLayerFactories,
  'liquidityLayerRouter'
> {
  readonly routerContractName = 'liquidityLayerRouter';

  constructor(multiProvider: MultiProvider) {
    super(multiProvider, liquidityLayerFactories);
  }

  async constructorArgs(_: string, __: LiquidityLayerConfig): Promise<[]> {
    return [];
  }

  async initializeArgs(
    chain: string,
    config: LiquidityLayerConfig,
  ): Promise<
    [
      _mailbox: string,
      _interchainGasPaymaster: string,
      _interchainSecurityModule: string,
      _owner: string,
    ]
  > {
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      owner,
    ];
  }

  async enrollRemoteRouters(
    contractsMap: HyperlaneContractsMap<LiquidityLayerFactories>,
    configMap: ChainMap<LiquidityLayerConfig>,
  ): Promise<void> {
    this.logger(`Enroll LiquidityLayerRouters with each other`);
    await super.enrollRemoteRouters(contractsMap, configMap);

    this.logger(`Enroll CircleBridgeAdapters with each other`);
    // Hack to allow use of super.enrollRemoteRouters
    await super.enrollRemoteRouters(
      objMap(
        objFilter(
          contractsMap,
          (_, c): c is HyperlaneContracts<LiquidityLayerFactories> =>
            !!c.circleBridgeAdapter,
        ),
        (_, contracts) => ({
          liquidityLayerRouter: contracts.circleBridgeAdapter,
        }),
      ) as unknown as HyperlaneContractsMap<LiquidityLayerFactories>,
      configMap,
    );

    this.logger(`Enroll PortalAdapters with each other`);
    // Hack to allow use of super.enrollRemoteRouters
    await super.enrollRemoteRouters(
      objMap(
        objFilter(
          contractsMap,
          (_, c): c is HyperlaneContracts<LiquidityLayerFactories> =>
            !!c.portalAdapter,
        ),
        (_, contracts) => ({
          liquidityLayerRouter: contracts.portalAdapter,
        }),
      ) as unknown as HyperlaneContractsMap<LiquidityLayerFactories>,
      configMap,
    );
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: ChainName,
    config: LiquidityLayerConfig,
  ): Promise<HyperlaneContracts<LiquidityLayerFactories>> {
    // This is just the temp owner for contracts, and HyperlaneRouterDeployer#transferOwnership actually sets the configured owner
    const tempOwner = await this.multiProvider.getSignerAddress(chain);

    const routerContracts = await super.deployContracts(chain, config);

    const bridgeAdapters: Partial<
      HyperlaneContracts<typeof liquidityLayerFactories>
    > = {};

    if (config.circle) {
      bridgeAdapters.circleBridgeAdapter = await this.deployCircleBridgeAdapter(
        chain,
        config.circle,
        tempOwner,
        routerContracts.liquidityLayerRouter,
      );
    }
    if (config.portal) {
      bridgeAdapters.portalAdapter = await this.deployPortalAdapter(
        chain,
        config.portal,
        tempOwner,
        routerContracts.liquidityLayerRouter,
      );
    }

    return {
      ...routerContracts,
      ...bridgeAdapters,
    };
  }

  async deployPortalAdapter(
    chain: ChainName,
    adapterConfig: PortalAdapterConfig,
    owner: string,
    router: LiquidityLayerRouter,
  ): Promise<PortalAdapter> {
    const portalAdapter = await this.deployContract(
      chain,
      'portalAdapter',
      [],
      [
        this.multiProvider.getDomainId(chain),
        owner,
        adapterConfig.portalBridgeAddress,
        router.address,
      ],
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
      await this.runIfOwner(chain, portalAdapter, () =>
        this.multiProvider.handleTx(
          chain,
          portalAdapter.addDomain(hyperlaneDomain, wormholeDomain),
        ),
      );
    }

    if (
      !utils.eqAddress(
        await router.liquidityLayerAdapters('Portal'),
        portalAdapter.address,
      )
    ) {
      this.logger('Set Portal as LiquidityLayerAdapter on Router');
      await this.runIfOwner(chain, portalAdapter, () =>
        this.multiProvider.handleTx(
          chain,
          router.setLiquidityLayerAdapter(
            adapterConfig.type,
            portalAdapter.address,
          ),
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
    const circleBridgeAdapter = await this.deployContract(
      chain,
      'circleBridgeAdapter',
      [],
      [
        owner,
        adapterConfig.tokenMessengerAddress,
        adapterConfig.messageTransmitterAddress,
        router.address,
      ],
    );

    if (
      !utils.eqAddress(
        await circleBridgeAdapter.tokenSymbolToAddress('USDC'),
        adapterConfig.usdcAddress,
      )
    ) {
      this.logger(`Set USDC token contract`);
      await this.runIfOwner(chain, circleBridgeAdapter, () =>
        this.multiProvider.handleTx(
          chain,
          circleBridgeAdapter.addToken(adapterConfig.usdcAddress, 'USDC'),
        ),
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
      await this.runIfOwner(chain, circleBridgeAdapter, () =>
        this.multiProvider.handleTx(
          chain,
          circleBridgeAdapter.addDomain(hyperlaneDomain, circleDomain),
        ),
      );
    }

    if (
      !utils.eqAddress(
        await router.liquidityLayerAdapters('Circle'),
        circleBridgeAdapter.address,
      )
    ) {
      this.logger('Set Circle as LiquidityLayerAdapter on Router');
      await this.runIfOwner(chain, circleBridgeAdapter, () =>
        this.multiProvider.handleTx(
          chain,
          router.setLiquidityLayerAdapter(
            adapterConfig.type,
            circleBridgeAdapter.address,
          ),
        ),
      );
    }

    return circleBridgeAdapter;
  }
}
