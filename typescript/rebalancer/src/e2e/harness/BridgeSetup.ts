import { BigNumber, ethers, providers } from 'ethers';

import {
  ERC20__factory,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';

export async function setupCollateralBalances(
  providers: Map<string, providers.JsonRpcProvider>,
  balancesByChain: Record<string, BigNumber>,
  routersByChain: Record<string, string>,
  tokensByChain: Record<string, string>,
  deployerKey: string,
): Promise<void> {
  for (const [chain, targetBalance] of Object.entries(balancesByChain)) {
    const provider = providers.get(chain);
    if (!provider) throw new Error(`No provider for chain ${chain}`);

    const deployer = new ethers.Wallet(deployerKey, provider);
    const token = ERC20__factory.connect(tokensByChain[chain], deployer);

    // First check current balance of the router
    const currentBalance = await token.balanceOf(routersByChain[chain]);

    // Transfer the target amount to the router (deployer has plenty from initial supply)
    // We need to set the exact balance, so transfer (targetBalance - currentBalance) if needed
    if (targetBalance.gt(currentBalance)) {
      const diff = targetBalance.sub(currentBalance);
      await token.transfer(routersByChain[chain], diff);
    }

    // Verify
    const verifyBalance = await token.balanceOf(routersByChain[chain]);
    if (!verifyBalance.eq(targetBalance)) {
      throw new Error(
        `Balance verification failed for ${chain}: expected ${targetBalance.toString()}, got ${verifyBalance.toString()}`,
      );
    }
  }
}

export async function getCollateralBalance(
  provider: providers.JsonRpcProvider,
  routerAddress: string,
  tokenAddress: string,
): Promise<BigNumber> {
  const token = ERC20__factory.connect(tokenAddress, provider);
  return token.balanceOf(routerAddress);
}

export async function getAllCollateralBalances(
  providers: Map<string, providers.JsonRpcProvider>,
  chains: readonly string[],
  routersByChain: Record<string, string>,
  tokensByChain: Record<string, string>,
): Promise<Record<string, BigNumber>> {
  const balances: Record<string, BigNumber> = {};
  for (const chain of chains) {
    const provider = providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain ${chain}`);
    }
    balances[chain] = await getCollateralBalance(
      provider,
      routersByChain[chain],
      tokensByChain[chain],
    );
  }
  return balances;
}

export interface AllowedBridgeConfig {
  monitoredRouterAddress: string;
  bridgeAddress: string;
  destinationDomain: number;
}

export async function configureAllowedBridges(
  provider: providers.JsonRpcProvider,
  configs: AllowedBridgeConfig[],
  deployerKey: string,
): Promise<void> {
  if (configs.length === 0) return;

  const deployer = new ethers.Wallet(deployerKey, provider);
  const router = MovableCollateralRouter__factory.connect(
    configs[0].monitoredRouterAddress,
    deployer,
  );

  for (const config of configs) {
    await router.addBridge(config.destinationDomain, config.bridgeAddress);
  }
}
