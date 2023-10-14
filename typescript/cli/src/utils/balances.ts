import { ethers } from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/hyperlane-token';
import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export async function assertNativeBalances(
  multiProvider: MultiProvider,
  signer: ethers.Signer,
  chains: ChainName[],
  minBalanceWei: string,
) {
  const address = await signer.getAddress();
  const minBalance = ethers.utils.formatEther(minBalanceWei.toString());
  await Promise.all(
    chains.map(async (chain) => {
      const balanceWei = await multiProvider
        .getProvider(chain)
        .getBalance(address);
      const balance = ethers.utils.formatEther(balanceWei);
      if (balanceWei.lte(minBalanceWei))
        throw new Error(
          `${address} has insufficient balance on ${chain}. At least ${minBalance} required but found ${balance.toString()} ETH`,
        );
    }),
  );
}

export async function assertTokenBalance(
  multiProvider: MultiProvider,
  signer: ethers.Signer,
  chain: ChainName,
  token: Address,
  minBalanceWei: string,
) {
  const address = await signer.getAddress();
  const provider = multiProvider.getProvider(chain);
  const tokenContract = ERC20__factory.connect(token, provider);
  const balanceWei = await tokenContract.balanceOf(address);
  if (balanceWei.lte(minBalanceWei))
    throw new Error(
      `${address} has insufficient balance on ${chain} for token ${token}. At least ${minBalanceWei} wei required but found ${balanceWei.toString()} wei`,
    );
}
