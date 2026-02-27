import {
  JsonRpcProvider,
  ZeroAddress,
  Wallet,
  toBeHex,
  zeroPadValue,
} from 'ethers';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';

import {
  type Erc20InventoryChainDeployment,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

type Erc20Contract = ReturnType<typeof ERC20Test__factory.connect>;
type HypRouterContract = ReturnType<typeof HypERC20Collateral__factory.connect>;

const TOKEN_SCALE = 1n;
const USDC_INITIAL_SUPPLY = '100000000000000';
const USDC_DECIMALS = 6;
const INVENTORY_INITIAL_ETH_BALANCE = '20000000000000000000'; // 20 ETH for gas/IGP
const INVENTORY_INITIAL_ERC20_BALANCE = '20000000000'; // 20,000 USDC for signer
const INVENTORY_ERC20_BRIDGE_SEED = '10000000000'; // 10,000 USDC bridge seed

export class Erc20InventoryLocalDeploymentManager extends BaseLocalDeploymentManager<Erc20InventoryDeployedAddresses> {
  constructor(private readonly inventorySignerAddress: string) {
    super();
  }

  protected async deployRoutes(
    deployerWallet: Wallet,
    providersByChain: Map<string, JsonRpcProvider>,
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
    const monitoredRouters = {} as Record<TestChain, HypRouterContract>;
    const bridgeRouters = {} as Record<TestChain, HypRouterContract>;
    const tokens = {} as Record<TestChain, Erc20Contract>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name)!;
      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        toBeHex(BigInt(INVENTORY_INITIAL_ETH_BALANCE)),
      ]);

      const deployer = deployerWallet.connect(provider);

      const token = await new ERC20Test__factory(deployer).deploy(
        'USDC',
        'USDC',
        USDC_INITIAL_SUPPLY,
        USDC_DECIMALS,
      );
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();

      const monitoredRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        tokenAddress,
        TOKEN_SCALE,
        TOKEN_SCALE,
        chainInfra[config.name].mailbox,
      );
      await monitoredRoute.waitForDeployment();
      await monitoredRoute.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );
      const monitoredRouterAddress = await monitoredRoute.getAddress();

      const bridgeRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        tokenAddress,
        TOKEN_SCALE,
        TOKEN_SCALE,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute.waitForDeployment();
      await bridgeRoute.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );
      const bridgeRouterAddress = await bridgeRoute.getAddress();

      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        monitoredRouter: monitoredRouterAddress,
        bridgeRouter: bridgeRouterAddress,
        token: tokenAddress,
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
            zeroPadValue(await routeMap[remote.name].getAddress(), 32),
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
          await bridgeRouters[chain.name].getAddress(),
        );
      }
    }

    const bridgeSeedAmount = BigInt(INVENTORY_ERC20_BRIDGE_SEED);
    const signerErc20Amount = BigInt(INVENTORY_INITIAL_ERC20_BALANCE);
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = deployerWallet.connect(provider);
      const token = ERC20Test__factory.connect(
        await tokens[chain.name].getAddress(),
        deployer,
      );
      await token.transfer(
        await bridgeRouters[chain.name].getAddress(),
        bridgeSeedAmount,
      );
      await token.transfer(this.inventorySignerAddress, signerErc20Amount);
    }

    return {
      chains: chainDeployments,
      monitoredRoute: {
        anvil1: await monitoredRouters.anvil1.getAddress(),
        anvil2: await monitoredRouters.anvil2.getAddress(),
        anvil3: await monitoredRouters.anvil3.getAddress(),
      },
      bridgeRoute: {
        anvil1: await bridgeRouters.anvil1.getAddress(),
        anvil2: await bridgeRouters.anvil2.getAddress(),
        anvil3: await bridgeRouters.anvil3.getAddress(),
      },
      tokens: {
        anvil1: await tokens.anvil1.getAddress(),
        anvil2: await tokens.anvil2.getAddress(),
        anvil3: await tokens.anvil3.getAddress(),
      },
    };
  }
}
