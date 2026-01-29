import { BigNumber, ethers, providers } from 'ethers';

import {
  ERC20__factory,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';
import {
  impersonateAccounts,
  setBalance,
  setStorageAt,
} from '@hyperlane-xyz/sdk';

const KNOWN_USDC_BALANCE_SLOTS: Record<string, number> = {
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 9, // Ethereum USDC
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 51, // Arbitrum native USDC
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 9, // Base USDC
};

function computeBalanceSlot(account: string, slotIndex: number): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint256'],
      [account, slotIndex],
    ),
  );
}

export async function verifyStorageSlot(
  provider: providers.JsonRpcProvider,
  tokenAddress: string,
  account: string,
  slotIndex: number,
): Promise<boolean> {
  const token = ERC20__factory.connect(tokenAddress, provider);
  const actualBalance = await token.balanceOf(account);
  const slot = computeBalanceSlot(account, slotIndex);
  const storageValue = await provider.getStorageAt(tokenAddress, slot);
  const storageBalance = BigNumber.from(storageValue);
  return actualBalance.eq(storageBalance);
}

export async function findBalanceSlot(
  provider: providers.JsonRpcProvider,
  tokenAddress: string,
  account: string,
): Promise<number | null> {
  const knownSlot = KNOWN_USDC_BALANCE_SLOTS[tokenAddress];
  if (knownSlot !== undefined) {
    const isValid = await verifyStorageSlot(
      provider,
      tokenAddress,
      account,
      knownSlot,
    );
    if (isValid) {
      return knownSlot;
    }
  }

  const commonSlots = [0, 1, 2, 3, 4, 5, 9, 51, 52];
  for (const slot of commonSlots) {
    const isValid = await verifyStorageSlot(
      provider,
      tokenAddress,
      account,
      slot,
    );
    if (isValid) {
      return slot;
    }
  }
  return null;
}

export async function setTokenBalanceViaStorage(
  provider: providers.JsonRpcProvider,
  tokenAddress: string,
  account: string,
  amount: BigNumber,
  slotIndex?: number,
): Promise<void> {
  let slot = slotIndex;
  if (slot === undefined) {
    const foundSlot = await findBalanceSlot(provider, tokenAddress, account);
    if (foundSlot === null) {
      throw new Error(
        `Could not find balance storage slot for token ${tokenAddress}`,
      );
    }
    slot = foundSlot;
  }

  const storageSlot = computeBalanceSlot(account, slot);
  const value = ethers.utils.hexZeroPad(amount.toHexString(), 32);
  await setStorageAt(provider, tokenAddress, storageSlot, value);
}

export interface SetCollateralBalanceConfig {
  routerAddress: string;
  tokenAddress: string;
  amount: BigNumber;
}

export async function setCollateralBalance(
  provider: providers.JsonRpcProvider,
  config: SetCollateralBalanceConfig,
): Promise<void> {
  const { routerAddress, tokenAddress, amount } = config;
  const token = ERC20__factory.connect(tokenAddress, provider);
  const currentBalance = await token.balanceOf(routerAddress);
  const newBalance = currentBalance.add(amount);
  await setTokenBalanceViaStorage(
    provider,
    tokenAddress,
    routerAddress,
    newBalance,
  );
  const verifyBalance = await token.balanceOf(routerAddress);
  if (!verifyBalance.eq(newBalance)) {
    throw new Error(
      `Balance verification failed for ${routerAddress}: expected ${newBalance.toString()}, got ${verifyBalance.toString()}`,
    );
  }
}

export async function setupCollateralBalances(
  providers: Map<string, providers.JsonRpcProvider>,
  balancesByChain: Record<string, BigNumber>,
  routersByChain: Record<string, string>,
  tokensByChain: Record<string, string>,
): Promise<void> {
  for (const [chain, targetBalance] of Object.entries(balancesByChain)) {
    const provider = providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain ${chain}`);
    }
    const routerAddress = routersByChain[chain];
    const tokenAddress = tokensByChain[chain];
    await setTokenBalanceViaStorage(
      provider,
      tokenAddress,
      routerAddress,
      targetBalance,
    );

    const token = ERC20__factory.connect(tokenAddress, provider);
    const verifyBalance = await token.balanceOf(routerAddress);
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
): Promise<void> {
  if (configs.length === 0) return;

  const router = MovableCollateralRouter__factory.connect(
    configs[0].monitoredRouterAddress,
    provider,
  );

  const owner = await router.owner();
  await impersonateAccounts(provider, [owner]);
  await setBalance(provider, owner, '0x56BC75E2D63100000');
  const ownerSigner = provider.getSigner(owner);

  const routerAsOwner = router.connect(ownerSigner);

  for (const config of configs) {
    await routerAsOwner.addBridge(
      config.destinationDomain,
      config.bridgeAddress,
    );
  }

  await provider.send('anvil_stopImpersonatingAccount', [owner]);
}
