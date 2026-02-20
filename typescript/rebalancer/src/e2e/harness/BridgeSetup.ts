import { ERC20__factory } from '@hyperlane-xyz/core';
import { LocalAccountEvmSigner, type MultiProvider } from '@hyperlane-xyz/sdk';
import { ensure0x } from '@hyperlane-xyz/utils';

export async function setupCollateralBalances(
  providers: Map<string, ReturnType<MultiProvider['getProvider']>>,
  balancesByChain: Record<string, bigint>,
  routersByChain: Record<string, string>,
  tokensByChain: Record<string, string>,
  deployerKey: string,
): Promise<void> {
  for (const [chain, targetBalance] of Object.entries(balancesByChain)) {
    const provider = providers.get(chain);
    if (!provider) throw new Error(`No provider for chain ${chain}`);

    const deployer = new LocalAccountEvmSigner(ensure0x(deployerKey)).connect(
      provider as any,
    );
    const token = ERC20__factory.connect(tokensByChain[chain], deployer);

    // First check current balance of the router
    const currentBalance = toBigInt(
      await token.balanceOf(routersByChain[chain]),
    );

    // Transfer the target amount to the router (deployer has plenty from initial supply)
    // We need to set the exact balance, so transfer (targetBalance - currentBalance) if needed
    if (targetBalance > currentBalance) {
      const diff = targetBalance - currentBalance;
      await token.transfer(routersByChain[chain], diff);
    }

    // Verify
    const verifyBalance = toBigInt(
      await token.balanceOf(routersByChain[chain]),
    );
    if (verifyBalance !== targetBalance) {
      throw new Error(
        `Balance verification failed for ${chain}: expected ${targetBalance}, got ${verifyBalance}`,
      );
    }
  }
}

export async function getCollateralBalance(
  provider: ReturnType<MultiProvider['getProvider']>,
  routerAddress: string,
  tokenAddress: string,
): Promise<bigint> {
  const token = ERC20__factory.connect(tokenAddress, provider);
  return toBigInt(await token.balanceOf(routerAddress));
}

export async function getAllCollateralBalances(
  providers: Map<string, ReturnType<MultiProvider['getProvider']>>,
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

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  return BigInt((value as { toString(): string }).toString());
}
