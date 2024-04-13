import { ethers } from 'ethers';

import {
  CircleBridgeAdapter,
  LiquidityLayerRouter,
  PortalAdapter,
  Router,
} from '@hyperlane-xyz/core';
import { Address, eqAddress, objFilter, objMap } from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../../contracts/types.js';
import { ContractVerifier } from '../../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer.js';
import { RouterConfig } from '../../router/types.js';
import { ChainMap, ChainName } from '../../types.js';

import {
  LiquidityLayerFactories,
  liquidityLayerFactories,
} from './contracts.js';

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
  LiquidityLayerFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, liquidityLayerFactories, {
      contractVerifier,
    });
  }
  routerContractName(): string {
    return 'LiquidityLayerRouter';
  }

  routerContractKey<K extends keyof LiquidityLayerFactories>(
    _: RouterConfig,
  ): K {
    return 'liquidityLayerRouter' as K;
  }

  router(contracts: HyperlaneContracts<LiquidityLayerFactories>): Router {
    return contracts.liquidityLayerRouter;
  }

  async constructorArgs<K extends keyof LiquidityLayerFactories>(
    _: string,
    config: LiquidityLayerConfig,
  ): Promise<Parameters<LiquidityLayerFactories[K]['deploy']>> {
    return [config.mailbox] as any;
  }

  async initializeArgs(
    chain: string,
    config: LiquidityLayerConfig,
  ): Promise<any> {
    const owner = await this.multiProvider.getSignerAddress(chain);
    if (typeof config.interchainSecurityModule === 'object') {
      throw new Error('ISM as object unimplemented');
    }
    return [
      config.hook ?? ethers.constants.AddressZero,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      owner,
    ];
  }

  async enrollRemoteRouters(
    contractsMap: HyperlaneContractsMap<LiquidityLayerFactories>,
    configMap: ChainMap<LiquidityLayerConfig>,
    foreignRouters: ChainMap<Address>,
  ): Promise<void> {
    this.logger.debug(`Enroll LiquidityLayerRouters with each other`);
    await super.enrollRemoteRouters(contractsMap, configMap, foreignRouters);

    this.logger.debug(`Enroll CircleBridgeAdapters with each other`);
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
      foreignRouters,
    );

    this.logger.debug(`Enroll PortalAdapters with each other`);
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
      foreignRouters,
    );
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: ChainName,
    config: LiquidityLayerConfig,
  ): Promise<HyperlaneContracts<LiquidityLayerFactories>> {
    // This is just the temp owner for contracts, and HyperlaneRouterDeployer#transferOwnership actually sets the configured owner
    const deployer = await this.multiProvider.getSignerAddress(chain);

    const routerContracts = await super.deployContracts(chain, config);

    const bridgeAdapters: Partial<
      HyperlaneContracts<typeof liquidityLayerFactories>
    > = {};

    if (config.circle) {
      bridgeAdapters.circleBridgeAdapter = await this.deployCircleBridgeAdapter(
        chain,
        config.circle,
        deployer,
        routerContracts.liquidityLayerRouter,
      );
    }
    if (config.portal) {
      bridgeAdapters.portalAdapter = await this.deployPortalAdapter(
        chain,
        config.portal,
        deployer,
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
    const mailbox = await router.mailbox();
    const portalAdapter = await this.deployContract(
      chain,
      'portalAdapter',
      [mailbox],
      [owner, adapterConfig.portalBridgeAddress, router.address],
    );

    for (const {
      wormholeDomain,
      hyperlaneDomain,
    } of adapterConfig.wormholeDomainMapping) {
      const expectedCircleDomain =
        await portalAdapter.hyperlaneDomainToWormholeDomain(hyperlaneDomain);
      if (expectedCircleDomain === wormholeDomain) continue;

      this.logger.debug(
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
      !eqAddress(
        await router.liquidityLayerAdapters('Portal'),
        portalAdapter.address,
      )
    ) {
      this.logger.debug('Set Portal as LiquidityLayerAdapter on Router');
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
    const mailbox = await router.mailbox();
    const circleBridgeAdapter = await this.deployContract(
      chain,
      'circleBridgeAdapter',
      [mailbox],
      [
        owner,
        adapterConfig.tokenMessengerAddress,
        adapterConfig.messageTransmitterAddress,
        router.address,
      ],
    );

    if (
      !eqAddress(
        await circleBridgeAdapter.tokenSymbolToAddress('USDC'),
        adapterConfig.usdcAddress,
      )
    ) {
      this.logger.debug(`Set USDC token contract`);
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

      this.logger.debug(
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
      !eqAddress(
        await router.liquidityLayerAdapters('Circle'),
        circleBridgeAdapter.address,
      )
    ) {
      this.logger.debug('Set Circle as LiquidityLayerAdapter on Router');
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
