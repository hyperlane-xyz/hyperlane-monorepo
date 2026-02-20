import { ethers, providers } from 'ethers';

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

const TOKEN_SCALE = ethers.BigNumber.from(1);
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
    const monitoredRouters = {} as Record<TestChain, ethers.Contract>;
    const bridgeRouters = {} as Record<TestChain, ethers.Contract>;
    const tokens = {} as Record<TestChain, ethers.Contract>;

    for (const config of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(config.name)!;
      await provider.send('anvil_setBalance', [
        this.inventorySignerAddress,
        ethers.utils.hexValue(
          ethers.BigNumber.from(INVENTORY_INITIAL_ETH_BALANCE),
        ),
      ]);

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
      ).deploy(token.address, TOKEN_SCALE, chainInfra[config.name].mailbox);
      await monitoredRoute.deployed();
      await monitoredRoute.initialize(
        ethers.constants.AddressZero,
        chainInfra[config.name].ism,
        deployerAddress,
      );

      const bridgeRoute = await new HypERC20Collateral__factory(
        deployer,
      ).deploy(token.address, TOKEN_SCALE, chainInfra[config.name].mailbox);
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

    const bridgeSeedAmount = ethers.BigNumber.from(INVENTORY_ERC20_BRIDGE_SEED);
    const signerErc20Amount = ethers.BigNumber.from(
      INVENTORY_INITIAL_ERC20_BALANCE,
    );
    for (const chain of TEST_CHAIN_CONFIGS) {
      const provider = providersByChain.get(chain.name)!;
      const deployer = deployerWallet.connect(provider);
      const token = ERC20Test__factory.connect(
        tokens[chain.name].address,
        deployer,
      );
      await token.transfer(bridgeRouters[chain.name].address, bridgeSeedAmount);
      await token.transfer(this.inventorySignerAddress, signerErc20Amount);
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
