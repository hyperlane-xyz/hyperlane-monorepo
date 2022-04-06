import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { ChainName, MultiProvider } from '@abacus-network/sdk';
import { registerDomains } from '@abacus-network/deploy';
import { configs } from '../../networks/testnets';

export const domainNames: ChainName[] = [
  'alfajores',
  'kovan',
  'mumbai',
  'fuji',
];

export const registerMultiProvider = (multiProvider: MultiProvider) => {
  // Hardhat account 0
  const key =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const provider = new ethers.providers.JsonRpcProvider(
    'http://localhost:8545',
  );

  const wallet = new ethers.Wallet(key, provider);
  const signer = new NonceManager(wallet);
  registerMultiProviderTest(multiProvider, signer);
};

export const registerMultiProviderTest = (
  multiProvider: MultiProvider,
  signer: ethers.Signer,
) => {
  registerDomains(domainNames, configs, multiProvider);
  domainNames.forEach((name) => {
    multiProvider.registerSigner(name, signer);
    // Hardhat mines blocks lazily so anything > 0 will cause the test to stall.
    multiProvider.registerConfirmations(name, 0);
  });
};
