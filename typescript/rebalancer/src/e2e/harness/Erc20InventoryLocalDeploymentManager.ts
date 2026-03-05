import { pad, toHex, zeroAddress } from 'viem';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
import { LocalAccountViemSigner, type MultiProvider } from '@hyperlane-xyz/sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

import {
  type Erc20InventoryChainDeployment,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

const TOKEN_SCALE = 1n;
const USDC_INITIAL_SUPPLY = 100000000000000n;
const USDC_DECIMALS = 6;
const INVENTORY_INITIAL_ETH_BALANCE = 20000000000000000000n; // 20 ETH for gas/IGP
const INVENTORY_INITIAL_ERC20_BALANCE = 20000000000n; // 20,000 USDC for signer
const INVENTORY_ERC20_BRIDGE_SEED = 10000000000n; // 10,000 USDC bridge seed

type Erc20TokenLike = {
  address: string;
  transfer: (to: string, amount: bigint) => Promise<unknown>;
};

type Erc20RouteLike = {
  address: string;
  initialize: (owner: string, ism: string, hook: string) => Promise<unknown>;
  enrollRemoteRouters: (
    domains: number[],
    routers: string[],
  ) => Promise<unknown>;
  addRebalancer: (address: string) => Promise<unknown>;
  addBridge: (domain: number, bridge: string) => Promise<unknown>;
};

export class Erc20InventoryLocalDeploymentManager extends BaseLocalDeploymentManager<Erc20InventoryDeployedAddresses> {
  constructor(private readonly inventorySignerAddress: string) {
    super();
  }

  protected async deployRoutes(
    deployerWallet: LocalAccountViemSigner,
    providersByChain: Map<string, ReturnType<MultiProvider['getProvider']>>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<Erc20InventoryDeployedAddresses> {
    const deployerAddress = await deployerWallet.getAddress();
    const chainDeployments = {} as Record<
      TestChain,
      Erc20InventoryChainDeployment
    >;
    const monitoredRouters = {} as Record<TestChain, Erc20RouteLike>;
    const bridgeRouters = {} as Record<TestChain, Erc20RouteLike>;
    const tokens = {} as Record<TestChain, Erc20TokenLike>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name);
      if (!provider) {
        throw new Error(`Missing provider for chain ${config.name}`);
      }

      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        toHex(INVENTORY_INITIAL_ETH_BALANCE),
      ]);

      const deployer = deployerWallet.connect(provider);

      const token = (await new ERC20Test__factory(deployer).deploy(
        'USDC',
        'USDC',
        USDC_INITIAL_SUPPLY,
        USDC_DECIMALS,
      )) as Erc20TokenLike;

      const monitoredRoute = (await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
        TOKEN_SCALE,
        TOKEN_SCALE,
        chainInfra[config.name].mailbox,
      )) as Erc20RouteLike;
      await monitoredRoute.initialize(
        zeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      const bridgeRoute = (await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
        TOKEN_SCALE,
        TOKEN_SCALE,
        chainInfra[config.name].mailbox,
      )) as Erc20RouteLike;
      await bridgeRoute.initialize(
        zeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        monitoredRouter: monitoredRoute.address,
        bridgeRouter: bridgeRoute.address,
        token: token.address,
      };

      tokens[config.name] = token;
      monitoredRouters[config.name] = monitoredRoute;
      bridgeRouters[config.name] = bridgeRoute;
    }

    const routeGroups = [monitoredRouters, bridgeRouters];
    for (const routeMap of routeGroups) {
      for (const chain of TEST_CHAIN_CONFIGS) {
        const localRoute = routeMap[chain.name];
        const remoteDomains: number[] = [];
        const remoteRouters: string[] = [];

        for (const remote of TEST_CHAIN_CONFIGS) {
          if (remote.name === chain.name) continue;
          remoteDomains.push(remote.domainId);
          remoteRouters.push(
            pad(routeMap[remote.name].address as `0x${string}`, { size: 32 }),
          );
        }

        await localRoute.enrollRemoteRouters(remoteDomains, remoteRouters);
      }
    }

    for (const chain of TEST_CHAIN_CONFIGS) {
      const monitoredRoute = monitoredRouters[chain.name];
      await monitoredRoute.addRebalancer(deployerAddress);
      await monitoredRoute.addRebalancer(this.inventorySignerAddress);

      for (const destination of TEST_CHAIN_CONFIGS) {
        if (destination.name === chain.name) continue;
        await monitoredRoute.addBridge(
          destination.domainId,
          bridgeRouters[chain.name].address,
        );
      }
    }

    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name);
      if (!provider) {
        throw new Error(`Missing provider for chain ${chain.name}`);
      }

      const deployer = deployerWallet.connect(provider);
      const token = ERC20Test__factory.connect(
        tokens[chain.name].address,
        deployer,
      );
      await token.transfer(
        bridgeRouters[chain.name].address,
        INVENTORY_ERC20_BRIDGE_SEED,
      );
      await token.transfer(
        this.inventorySignerAddress,
        INVENTORY_INITIAL_ERC20_BALANCE,
      );
    }

    return {
      chains: chainDeployments,
      monitoredRoute: {
        anvil1: monitoredRouters.anvil1.address,
        anvil2: monitoredRouters.anvil2.address,
        anvil3: monitoredRouters.anvil3.address,
      },
      bridgeRoute: {
        anvil1: bridgeRouters.anvil1.address,
        anvil2: bridgeRouters.anvil2.address,
        anvil3: bridgeRouters.anvil3.address,
      },
      tokens: {
        anvil1: tokens.anvil1.address,
        anvil2: tokens.anvil2.address,
        anvil3: tokens.anvil3.address,
      },
    };
  }
}
