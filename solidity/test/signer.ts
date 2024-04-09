import type { Wallet } from 'ethers';
import hre from 'hardhat';

export async function getSigners(): Promise<Wallet[]> {
  // @ts-ignore Hardhat type overrides from @nomiclabs/hardhat-ethers don't work
  return hre.ethers.getSigners();
}

export async function getSigner(): Promise<Wallet> {
  const [signer] = await getSigners();
  return signer;
}
