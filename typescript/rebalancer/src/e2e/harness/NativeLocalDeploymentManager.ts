import { pad, toHex, zeroAddress } from 'viem';

import { HypNative__factory } from '@hyperlane-xyz/core';
import { LocalAccountViemSigner, MultiProvider } from '@hyperlane-xyz/sdk';

import {
  type NativeChainDeployment,
  type NativeDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

const TOKEN_SCALE_NUMERATOR = 1n;
const TOKEN_SCALE_DENOMINATOR = 1n;
const INVENTORY_INITIAL_BALANCE = '20000000000000000000';
const INVENTORY_BRIDGE_SEED = '10000000000000000000';

export class NativeLocalDeploymentManager extends BaseLocalDeploymentManager<NativeDeployedAddresses> {
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
  ): Promise<NativeDeployedAddresses> {
    const deployerAddress = await deployerWallet.getAddress();
    const chainDeployments = {} as Record<TestChain, NativeChainDeployment>;
    const monitoredRouters = {} as Record<TestChain, any>;
    const bridgeRouters = {} as Record<TestChain, any>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name)!;
      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        toHex(BigInt(INVENTORY_INITIAL_BALANCE)),
      ]);

      const deployer = deployerWallet.connect(provider);

      const monitoredRoute = await new HypNative__factory(deployer).deploy(
        TOKEN_SCALE_NUMERATOR,
        TOKEN_SCALE_DENOMINATOR,
        chainInfra[config.name].mailbox,
      );
      await monitoredRoute.deployed();
      await monitoredRoute.initialize(
        zeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      const bridgeRoute = await new HypNative__factory(deployer).deploy(
        TOKEN_SCALE_NUMERATOR,
        TOKEN_SCALE_DENOMINATOR,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute.deployed();
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
            pad(routeMap[remote.name].address as `0x${string}`, {
              size: 32,
            }),
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

    const bridgeSeedAmount = BigInt(INVENTORY_BRIDGE_SEED);
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = deployerWallet.connect(provider);
      await deployer.sendTransaction({
        to: bridgeRouters[chain.name].address,
        value: bridgeSeedAmount,
      });
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
    };
  }
}
