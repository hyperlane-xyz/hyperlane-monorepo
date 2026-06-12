import { ethers, providers } from 'ethers';

import { ExecutionType, ExternalBridgeType } from '../../config/types.js';
import {
  type Erc20InventoryChainDeployment,
  type Erc20InventoryDeployedAddresses,
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
  seedErc20Recipient,
  seedErc20RouteGroups,
} from './RouteFixtureBuilder.js';

const TOKEN_SCALE = ethers.BigNumber.from(1);
const USDC_INITIAL_SUPPLY = '100000000000000';
const USDC_DECIMALS = 6;
const INVENTORY_INITIAL_ETH_BALANCE = '20000000000000000000';
const INVENTORY_INITIAL_ERC20_BALANCE = '20000000000';
const INVENTORY_ERC20_BRIDGE_SEED = '10000000000';

export const MIXED_MOVABLE_CHAINS: readonly TestChain[] = ['anvil1', 'anvil2'];
export const MIXED_INVENTORY_CHAIN: TestChain = 'anvil3';

export const MIXED_INVENTORY_OVERRIDE = {
  executionType: ExecutionType.Inventory,
  externalBridge: ExternalBridgeType.LiFi,
} as const;

export class MixedLocalDeploymentManager extends BaseLocalDeploymentManager<Erc20InventoryDeployedAddresses> {
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
  ): Promise<Erc20InventoryDeployedAddresses> {
    const deployerAddress = deployerWallet.address;
    const chainDeployments = {} as Record<
      TestChain,
      Erc20InventoryChainDeployment
    >;
    const fixture = await new RouteFixtureBuilder({
      deployerWallet,
      providersByChain,
      chainInfra,
      ownerAddress: deployerAddress,
    })
      .withNativeBalance(
        this.inventorySignerAddress,
        ethers.BigNumber.from(INVENTORY_INITIAL_ETH_BALANCE),
      )
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
        scaleNumerator: TOKEN_SCALE,
        scaleDenominator: TOKEN_SCALE,
      })
      .withErc20CollateralRouteGroup({
        id: 'bridge',
        tokenId: 'usdc',
        scaleNumerator: TOKEN_SCALE,
        scaleDenominator: TOKEN_SCALE,
      })
      .deploy();

    const tokens = fixture.tokens.usdc;
    const monitoredRouters = fixture.routeGroups.monitored;
    const bridgeRouters = fixture.routeGroups.bridge;

    for (const config of TEST_CHAIN_CONFIGS) {
      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        monitoredRouter: monitoredRouters[config.name].address,
        bridgeRouter: bridgeRouters[config.name].address,
        token: tokens[config.name].address,
      };
    }

    await enrollRouteGroups([monitoredRouters, bridgeRouters]);
    await addRebalancersToRouteGroups([monitoredRouters], (chain) =>
      chain === MIXED_INVENTORY_CHAIN
        ? [deployerAddress, this.inventorySignerAddress]
        : [deployerAddress],
    );
    await addBridgesToMonitoredRoutes(monitoredRouters, [bridgeRouters]);

    const bridgeSeedAmount = ethers.BigNumber.from(INVENTORY_ERC20_BRIDGE_SEED);
    const signerErc20Amount = ethers.BigNumber.from(
      INVENTORY_INITIAL_ERC20_BALANCE,
    );
    await seedErc20RouteGroups({
      deployerWallet,
      providersByChain,
      tokens,
      routeGroups: [bridgeRouters],
      amount: bridgeSeedAmount,
    });
    await seedErc20Recipient({
      deployerWallet,
      providersByChain,
      tokens,
      recipient: this.inventorySignerAddress,
      amount: signerErc20Amount,
    });

    return {
      chains: chainDeployments,
      monitoredRoute: routeAddresses(monitoredRouters),
      bridgeRoute: routeAddresses(bridgeRouters),
      tokens: routeAddresses(tokens),
    };
  }
}

export default MixedLocalDeploymentManager;
