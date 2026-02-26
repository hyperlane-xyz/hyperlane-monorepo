import { ethers, providers } from 'ethers';

import { HypNative__factory } from '@hyperlane-xyz/core';

import {
  type NativeChainDeployment,
  type NativeDeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

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
    const monitoredRouters = {} as Record<TestChain, ethers.Contract>;
    const bridgeRouters = {} as Record<TestChain, ethers.Contract>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name)!;
      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        ethers.utils.hexValue(ethers.BigNumber.from(INVENTORY_INITIAL_BALANCE)),
      ]);

      const deployer = deployerWallet.connect(provider);

      const monitoredRoute = await new HypNative__factory(deployer).deploy(
        TOKEN_SCALE_NUMERATOR,
        TOKEN_SCALE_DENOMINATOR,
        chainInfra[config.name].mailbox,
      );
      await monitoredRoute.deployed();
      await monitoredRoute.initialize(
        ethers.constants.AddressZero,
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
        ethers.constants.AddressZero,
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
            ethers.utils.hexZeroPad(routeMap[remote.name].address, 32),
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

    const bridgeSeedAmount = ethers.BigNumber.from(INVENTORY_BRIDGE_SEED);
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
