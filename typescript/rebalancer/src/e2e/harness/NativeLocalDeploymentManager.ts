import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  toBeHex,
  zeroPadValue,
} from 'ethers';

import { HypNative__factory } from '@hyperlane-xyz/core';

import {
  type NativeChainDeployment,
  type NativeDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

const TOKEN_SCALE = 1n;
const INVENTORY_INITIAL_BALANCE = '20000000000000000000';
const INVENTORY_BRIDGE_SEED = '10000000000000000000';

export class NativeLocalDeploymentManager extends BaseLocalDeploymentManager<NativeDeployedAddresses> {
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
  ): Promise<NativeDeployedAddresses> {
    const deployerAddress = await deployerWallet.getAddress();
    const chainDeployments = {} as Record<TestChain, NativeChainDeployment>;
    const monitoredRouters = {} as Record<TestChain, Contract>;
    const bridgeRouters = {} as Record<TestChain, Contract>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name)!;
      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        toBeHex(BigInt(INVENTORY_INITIAL_BALANCE)),
      ]);

      const deployer = deployerWallet.connect(provider);

      const monitoredRoute = await new HypNative__factory(deployer).deploy(
        TOKEN_SCALE,
        1n,
        chainInfra[config.name].mailbox,
      );
      await monitoredRoute.waitForDeployment();
      await monitoredRoute.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      const bridgeRoute = await new HypNative__factory(deployer).deploy(
        TOKEN_SCALE,
        1n,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute.waitForDeployment();
      await bridgeRoute.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        monitoredRouter: await monitoredRoute.getAddress(),
        bridgeRouter: await bridgeRoute.getAddress(),
      };

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

    const bridgeSeedAmount = BigInt(INVENTORY_BRIDGE_SEED);
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = deployerWallet.connect(provider);
      await deployer.sendTransaction({
        to: await bridgeRouters[chain.name].getAddress(),
        value: bridgeSeedAmount,
      });
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
    };
  }
}
