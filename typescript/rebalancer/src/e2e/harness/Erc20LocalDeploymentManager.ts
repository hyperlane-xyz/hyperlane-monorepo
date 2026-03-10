import {
  Contract,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroAddress,
  zeroPadValue,
} from 'ethers';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';

import {
  type ChainDeployment,
  type DeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

const USDC_INITIAL_SUPPLY = '100000000000000';
const USDC_DECIMALS = 6;
const TOKEN_SCALE = 1n;

export class Erc20LocalDeploymentManager extends BaseLocalDeploymentManager<DeployedAddresses> {
  protected async deployRoutes(
    deployerWallet: Wallet,
    providersByChain: Map<string, JsonRpcProvider>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<DeployedAddresses> {
    const deployerAddress = await deployerWallet.getAddress();
    const chainDeployments = {} as Record<TestChain, ChainDeployment>;
    const monitoredRouters = {} as Record<TestChain, Contract>;
    const bridgeRouters1 = {} as Record<TestChain, Contract>;
    const bridgeRouters2 = {} as Record<TestChain, Contract>;
    const tokens = {} as Record<TestChain, Contract>;

    for (let i = 0; i < TEST_CHAIN_CONFIGS.length; i++) {
      const config = TEST_CHAIN_CONFIGS[i];
      const provider = providersByChain.get(config.name)!;
      const deployer = new NonceManager(deployerWallet.connect(provider));

      const token = await new ERC20Test__factory(deployer).deploy(
        'USDC',
        'USDC',
        USDC_INITIAL_SUPPLY,
        USDC_DECIMALS,
      );
      await token.waitForDeployment();

      const monitoredRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        await token.getAddress(),
        TOKEN_SCALE,
        1n,
        chainInfra[config.name].mailbox,
      );
      await monitoredRoute.waitForDeployment();
      const initializeMonitoredTx = await monitoredRoute.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );
      await initializeMonitoredTx.wait();

      const bridgeRoute1 = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        await token.getAddress(),
        TOKEN_SCALE,
        1n,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute1.waitForDeployment();
      const initializeBridge1Tx = await bridgeRoute1.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );
      await initializeBridge1Tx.wait();

      const bridgeRoute2 = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        await token.getAddress(),
        TOKEN_SCALE,
        1n,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute2.waitForDeployment();
      const initializeBridge2Tx = await bridgeRoute2.initialize(
        ZeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );
      await initializeBridge2Tx.wait();

      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        token: await token.getAddress(),
        monitoredRouter: await monitoredRoute.getAddress(),
        bridgeRouter1: await bridgeRoute1.getAddress(),
        bridgeRouter2: await bridgeRoute2.getAddress(),
      };

      tokens[config.name] = token;
      monitoredRouters[config.name] = monitoredRoute;
      bridgeRouters1[config.name] = bridgeRoute1;
      bridgeRouters2[config.name] = bridgeRoute2;
    }

    const routeGroups = [monitoredRouters, bridgeRouters1, bridgeRouters2];
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

        const enrollTx = await localRoute.enrollRemoteRouters(
          remoteDomains,
          remoteRouters,
        );
        await enrollTx.wait();
        const addRebalancerTx = await localRoute.addRebalancer(deployerAddress);
        await addRebalancerTx.wait();
      }
    }

    for (const chain of TEST_CHAIN_CONFIGS) {
      const monitoredRoute = monitoredRouters[chain.name];
      for (const destination of TEST_CHAIN_CONFIGS) {
        if (destination.name === chain.name) continue;
        const addBridge1Tx = await monitoredRoute.addBridge(
          destination.domainId,
          await bridgeRouters1[chain.name].getAddress(),
        );
        await addBridge1Tx.wait();
        const addBridge2Tx = await monitoredRoute.addBridge(
          destination.domainId,
          await bridgeRouters2[chain.name].getAddress(),
        );
        await addBridge2Tx.wait();
      }
    }

    const bridgeSeedAmount = BigInt(USDC_INITIAL_SUPPLY) / 10n;
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = new NonceManager(deployerWallet.connect(provider));
      const token = ERC20Test__factory.connect(
        await tokens[chain.name].getAddress(),
        deployer,
      );
      const bridge1SeedTx = await token.transfer(
        await bridgeRouters1[chain.name].getAddress(),
        bridgeSeedAmount,
      );
      await bridge1SeedTx.wait();
      const bridge2SeedTx = await token.transfer(
        await bridgeRouters2[chain.name].getAddress(),
        bridgeSeedAmount,
      );
      await bridge2SeedTx.wait();
    }

    return {
      chains: chainDeployments,
      monitoredRoute: {
        anvil1: await monitoredRouters.anvil1.getAddress(),
        anvil2: await monitoredRouters.anvil2.getAddress(),
        anvil3: await monitoredRouters.anvil3.getAddress(),
      },
      bridgeRoute1: {
        anvil1: await bridgeRouters1.anvil1.getAddress(),
        anvil2: await bridgeRouters1.anvil2.getAddress(),
        anvil3: await bridgeRouters1.anvil3.getAddress(),
      },
      bridgeRoute2: {
        anvil1: await bridgeRouters2.anvil1.getAddress(),
        anvil2: await bridgeRouters2.anvil2.getAddress(),
        anvil3: await bridgeRouters2.anvil3.getAddress(),
      },
      tokens: {
        anvil1: await tokens.anvil1.getAddress(),
        anvil2: await tokens.anvil2.getAddress(),
        anvil3: await tokens.anvil3.getAddress(),
      },
    };
  }
}
