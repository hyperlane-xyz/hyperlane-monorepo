import { JsonRpcProvider, NonceManager, Wallet } from 'ethers';

import {
  ERC20__factory,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';

export async function setupCollateralBalances(
  providers: Map<string, JsonRpcProvider>,
  balancesByChain: Record<string, bigint>,
  routersByChain: Record<string, string>,
  tokensByChain: Record<string, string>,
  deployerKey: string,
): Promise<void> {
  for (const [chain, targetBalance] of Object.entries(balancesByChain)) {
    const provider = providers.get(chain);
    if (!provider) throw new Error(`No provider for chain ${chain}`);

    const deployer = new NonceManager(new Wallet(deployerKey, provider));
    const token = ERC20__factory.connect(tokensByChain[chain], deployer);

    // First check current balance of the router
    const currentBalance = await token.balanceOf(routersByChain[chain]);

    // Transfer the target amount to the router (deployer has plenty from initial supply)
    // We need to set the exact balance, so transfer (targetBalance - currentBalance) if needed
    if (targetBalance > currentBalance) {
      const diff = targetBalance - currentBalance;
      const transferTx = await token.transfer(routersByChain[chain], diff);
      await transferTx.wait();
    }

    // Verify
    const verifyBalance = await token.balanceOf(routersByChain[chain]);
    if (verifyBalance !== targetBalance) {
      throw new Error(
        `Balance verification failed for ${chain}: expected ${targetBalance.toString()}, got ${verifyBalance.toString()}`,
      );
    }
  }
}

export async function getCollateralBalance(
  provider: JsonRpcProvider,
  routerAddress: string,
  tokenAddress: string,
): Promise<bigint> {
  const token = ERC20__factory.connect(tokenAddress, provider);
  return token.balanceOf(routerAddress);
}

export async function getAllCollateralBalances(
  providers: Map<string, JsonRpcProvider>,
  chains: readonly string[],
  routersByChain: Record<string, string>,
  tokensByChain: Record<string, string>,
): Promise<Record<string, bigint>> {
  const balances: Record<string, bigint> = {};
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
  provider: JsonRpcProvider,
  configs: AllowedBridgeConfig[],
  deployerKey: string,
): Promise<void> {
  if (configs.length === 0) return;

  const deployer = new NonceManager(new Wallet(deployerKey, provider));
  const router = MovableCollateralRouter__factory.connect(
    configs[0].monitoredRouterAddress,
    deployer,
  );

  for (const config of configs) {
    const addBridgeTx = await router.addBridge(
      config.destinationDomain,
      config.bridgeAddress,
    );
    await addBridgeTx.wait();
  }
}
