import { pad, zeroAddress } from 'viem';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
import { LocalAccountViemSigner, MultiProvider } from '@hyperlane-xyz/sdk';

import {
  type ChainDeployment,
  type DeployedAddresses,
  TEST_CHAIN_CONFIGS,
  type TestChain,
} from '../fixtures/routes.js';

import { BaseLocalDeploymentManager } from './BaseLocalDeploymentManager.js';

const USDC_INITIAL_SUPPLY = '100000000000000';
const USDC_DECIMALS = 6;
const TOKEN_SCALE_NUMERATOR = 1n;
const TOKEN_SCALE_DENOMINATOR = 1n;

export class Erc20LocalDeploymentManager extends BaseLocalDeploymentManager<DeployedAddresses> {
  protected async deployRoutes(
    deployerWallet: LocalAccountViemSigner,
    providersByChain: Map<string, ReturnType<MultiProvider['getProvider']>>,
    chainInfra: Record<
      string,
      { mailbox: string; ism: string; merkleHook: string }
    >,
  ): Promise<DeployedAddresses> {
    const deployerAddress = await deployerWallet.getAddress();
    const chainDeployments = {} as Record<TestChain, ChainDeployment>;
    const monitoredRouters = {} as Record<TestChain, any>;
    const bridgeRouters1 = {} as Record<TestChain, any>;
    const bridgeRouters2 = {} as Record<TestChain, any>;
    const tokens = {} as Record<TestChain, any>;

    for (let i = 0; i < TEST_CHAIN_CONFIGS.length; i++) {
      const config = TEST_CHAIN_CONFIGS[i];
      const provider = providersByChain.get(config.name)!;
      const deployer = deployerWallet.connect(provider);

      const token = await new ERC20Test__factory(deployer).deploy(
        'USDC',
        'USDC',
        USDC_INITIAL_SUPPLY,
        USDC_DECIMALS,
      );
      await token.deployed();

      const monitoredRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
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

      const bridgeRoute1 = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
        TOKEN_SCALE_NUMERATOR,
        TOKEN_SCALE_DENOMINATOR,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute1.deployed();
      await bridgeRoute1.initialize(
        zeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      const bridgeRoute2 = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(
        token.address,
        TOKEN_SCALE_NUMERATOR,
        TOKEN_SCALE_DENOMINATOR,
        chainInfra[config.name].mailbox,
      );
      await bridgeRoute2.deployed();
      await bridgeRoute2.initialize(
        zeroAddress,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      chainDeployments[config.name] = {
        mailbox: chainInfra[config.name].mailbox,
        ism: chainInfra[config.name].ism,
        token: token.address,
        monitoredRouter: monitoredRoute.address,
        bridgeRouter1: bridgeRoute1.address,
        bridgeRouter2: bridgeRoute2.address,
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
            pad(routeMap[remote.name].address as `0x${string}`, {
              size: 32,
            }),
          );
        }

        await localRoute.enrollRemoteRouters(remoteDomains, remoteRouters);
        await localRoute.addRebalancer(deployerAddress);
      }
    }

    for (const chain of TEST_CHAIN_CONFIGS) {
      const monitoredRoute = monitoredRouters[chain.name];
      for (const destination of TEST_CHAIN_CONFIGS) {
        if (destination.name === chain.name) continue;
        await monitoredRoute.addBridge(
          destination.domainId,
          bridgeRouters1[chain.name].address,
        );
        await monitoredRoute.addBridge(
          destination.domainId,
          bridgeRouters2[chain.name].address,
        );
      }
    }

    const bridgeSeedAmount = BigInt(USDC_INITIAL_SUPPLY) / 10n;
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = deployerWallet.connect(provider);
      const token = ERC20Test__factory.connect(
        tokens[chain.name].address,
        deployer,
      );
      await token.transfer(
        bridgeRouters1[chain.name].address,
        bridgeSeedAmount,
      );
      await token.transfer(
        bridgeRouters2[chain.name].address,
        bridgeSeedAmount,
      );
    }

    return {
      chains: chainDeployments,
      monitoredRoute: {
        anvil1: monitoredRouters.anvil1.address,
        anvil2: monitoredRouters.anvil2.address,
        anvil3: monitoredRouters.anvil3.address,
      },
      bridgeRoute1: {
        anvil1: bridgeRouters1.anvil1.address,
        anvil2: bridgeRouters1.anvil2.address,
        anvil3: bridgeRouters1.anvil3.address,
      },
      bridgeRoute2: {
        anvil1: bridgeRouters2.anvil1.address,
        anvil2: bridgeRouters2.anvil2.address,
        anvil3: bridgeRouters2.anvil3.address,
      },
      tokens: {
        anvil1: tokens.anvil1.address,
        anvil2: tokens.anvil2.address,
        anvil3: tokens.anvil3.address,
      },
    };
  }
}
