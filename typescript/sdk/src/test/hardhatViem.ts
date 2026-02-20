import hre from 'hardhat';
import { Web3Provider } from 'zksync-ethers';

export type HardhatSignerWithAddress = { address: string; [key: string]: any };

export function getHardhatProvider() {
  return new Web3Provider(hre.network.provider as any);
}

function attachAddress<T extends HardhatSignerWithAddress>(
  signer: T,
  address: string,
): T {
  signer.address = address;
  return signer;
}

export async function getHardhatSigners(): Promise<HardhatSignerWithAddress[]> {
  const wallets = await hre.viem.getWalletClients();
  const provider = getHardhatProvider();
  return wallets.map((wallet) =>
    attachAddress(
      provider.getSigner(wallet.account.address) as HardhatSignerWithAddress,
      wallet.account.address,
    ),
  );
}

export async function getImpersonatedHardhatSigner(
  account: string,
): Promise<HardhatSignerWithAddress> {
  await hre.network.provider.send('hardhat_impersonateAccount', [account]);
  const provider = getHardhatProvider();
  return attachAddress(
    provider.getSigner(account) as HardhatSignerWithAddress,
    account,
  );
}
