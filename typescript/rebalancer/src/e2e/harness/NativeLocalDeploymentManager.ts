import { ethers, providers } from 'ethers';

import {
  type NativeChainDeployment,
  type NativeDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';
import {
  addBridgesToMonitoredRoutes,
  addRebalancersToRouteGroups,
  enrollRouteGroups,
  routeAddresses,
  RouteFixtureBuilder,
  seedNativeRouteGroup,
} from './RouteFixtureBuilder.js';

const TOKEN_SCALE_NUMERATOR = ethers.BigNumber.from(1);
const TOKEN_SCALE_DENOMINATOR = ethers.BigNumber.from(1);
const INVENTORY_INITIAL_BALANCE = '20000000000000000000';
const INVENTORY_BRIDGE_SEED = '10000000000000000000';

export class NativeLocalDeploymentManager extends BaseLocalDeploymentManager<NativeDeployedAddresses> {
  constructor(private readonly inventorySignerAddress: string) {
    super();
  }

  protected async deployRoutes(
    deployerWallet: ethers.Wallet,
    providersByChain: Map<string, providers.JsonRpcProvider>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<NativeDeployedAddresses> {
    const deployerAddress = deployerWallet.address;
    const chainDeployments = {} as Record<TestChain, NativeChainDeployment>;
    const fixture = await new RouteFixtureBuilder({
      deployerWallet,
      providersByChain,
      chainInfra,
      ownerAddress: deployerAddress,
    })
      .withNativeBalance(
        this.inventorySignerAddress,
        ethers.BigNumber.from(INVENTORY_INITIAL_BALANCE),
      )
      .withNativeRouteGroup({
        id: 'monitored',
        scaleNumerator: TOKEN_SCALE_NUMERATOR,
        scaleDenominator: TOKEN_SCALE_DENOMINATOR,
      })
      .withNativeRouteGroup({
        id: 'bridge',
        scaleNumerator: TOKEN_SCALE_NUMERATOR,
        scaleDenominator: TOKEN_SCALE_DENOMINATOR,
      })
      .deploy();

    const monitoredRouters = fixture.routeGroups.monitored;
    const bridgeRouters = fixture.routeGroups.bridge;

    for (const config of TEST_CHAIN_CONFIGS) {
      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        monitoredRouter: monitoredRouters[config.name].address,
        bridgeRouter: bridgeRouters[config.name].address,
      };
    }

    await enrollRouteGroups([monitoredRouters, bridgeRouters]);
    await addRebalancersToRouteGroups([monitoredRouters], () => [
      deployerAddress,
      this.inventorySignerAddress,
    ]);
    await addBridgesToMonitoredRoutes(monitoredRouters, [bridgeRouters]);

    const bridgeSeedAmount = ethers.BigNumber.from(INVENTORY_BRIDGE_SEED);
    await seedNativeRouteGroup({
      deployerWallet,
      providersByChain,
      routeGroup: bridgeRouters,
      amount: bridgeSeedAmount,
    });

    return {
      chains: chainDeployments,
      monitoredRoute: routeAddresses(monitoredRouters),
      bridgeRoute: routeAddresses(bridgeRouters),
    };
  }
}
