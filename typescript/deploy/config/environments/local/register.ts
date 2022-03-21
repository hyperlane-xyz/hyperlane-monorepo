import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { ChainName, domains } from '@abacus-network/sdk';
import { AbacusAppDeployer } from '../../../src/deploy';

export const registerDeployer = (deployer: AbacusAppDeployer<any, any>) => {
  const domainNames: ChainName[] = ['alfajores', 'kovan', 'mumbai', 'fuji']
  domainNames.forEach((name) => deployer.registerDomain(domains[name]))
  // Hardhat account 0
  const key =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const provider = new ethers.providers.JsonRpcProvider(
    'http://127.0.0.1:8545/',
  );
  const wallet = new ethers.Wallet(key, provider);
  const signer = new NonceManager(wallet);
  domainNames.forEach((name) => deployer.registerSigner(name, signer))
};
