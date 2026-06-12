import { ethers, providers } from 'ethers';

import {
  type ChainDeployment,
  type DeployedAddresses,
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
  seedErc20RouteGroups,
} from './RouteFixtureBuilder.js';

const USDC_INITIAL_SUPPLY = '100000000000000';
const USDC_DECIMALS = 6;
const TOKEN_SCALE_NUMERATOR = ethers.BigNumber.from(1);
const TOKEN_SCALE_DENOMINATOR = ethers.BigNumber.from(1);

export class Erc20LocalDeploymentManager extends BaseLocalDeploymentManager<DeployedAddresses> {
  protected async deployRoutes(
    deployerWallet: ethers.Wallet,
    providersByChain: Map<string, providers.JsonRpcProvider>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<DeployedAddresses> {
    const deployerAddress = deployerWallet.address;
    const chainDeployments = {} as Record<TestChain, ChainDeployment>;
    const fixture = await new RouteFixtureBuilder({
      deployerWallet,
      providersByChain,
      chainInfra,
      ownerAddress: deployerAddress,
    })
      .withErc20Token({
        id: 'usdc',
        name: 'USDC',
        symbol: 'USDC',
        initialSupply: USDC_INITIAL_SUPPLY,
        decimals: USDC_DECIMALS,
      })
      .withErc20CollateralRouteGroup({
        id: 'monitored',
        tokenId: 'usdc',
        scaleNumerator: TOKEN_SCALE_NUMERATOR,
        scaleDenominator: TOKEN_SCALE_DENOMINATOR,
      })
      .withErc20CollateralRouteGroup({
        id: 'bridge1',
        tokenId: 'usdc',
        scaleNumerator: TOKEN_SCALE_NUMERATOR,
        scaleDenominator: TOKEN_SCALE_DENOMINATOR,
      })
      .withErc20CollateralRouteGroup({
        id: 'bridge2',
        tokenId: 'usdc',
        scaleNumerator: TOKEN_SCALE_NUMERATOR,
        scaleDenominator: TOKEN_SCALE_DENOMINATOR,
      })
      .deploy();

    const tokens = fixture.tokens.usdc;
    const monitoredRouters = fixture.routeGroups.monitored;
    const bridgeRouters1 = fixture.routeGroups.bridge1;
    const bridgeRouters2 = fixture.routeGroups.bridge2;

    for (const config of TEST_CHAIN_CONFIGS) {
      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        token: tokens[config.name].address,
        monitoredRouter: monitoredRouters[config.name].address,
        bridgeRouter1: bridgeRouters1[config.name].address,
        bridgeRouter2: bridgeRouters2[config.name].address,
      };
    }

    const routeGroups = [monitoredRouters, bridgeRouters1, bridgeRouters2];
    await enrollRouteGroups(routeGroups);
    await addRebalancersToRouteGroups(routeGroups, () => [deployerAddress]);
    await addBridgesToMonitoredRoutes(monitoredRouters, [
      bridgeRouters1,
      bridgeRouters2,
    ]);

    const bridgeSeedAmount = ethers.BigNumber.from(USDC_INITIAL_SUPPLY).div(10);
    await seedErc20RouteGroups({
      deployerWallet,
      providersByChain,
      tokens,
      routeGroups: [bridgeRouters1, bridgeRouters2],
      amount: bridgeSeedAmount,
    });

    return {
      chains: chainDeployments,
      monitoredRoute: routeAddresses(monitoredRouters),
      bridgeRoute1: routeAddresses(bridgeRouters1),
      bridgeRoute2: routeAddresses(bridgeRouters2),
      tokens: routeAddresses(tokens),
    };
  }
}
