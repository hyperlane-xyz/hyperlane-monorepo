import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import {
  alfajores,
  kovan,
  mumbai,
  fuji,
} from '../../../config/networks/testnets';

export const getChains = () => {
  // Hardhat account 0
  const key =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const provider = new ethers.providers.JsonRpcProvider(
    'http://127.0.0.1:8545/',
  );
  const wallet = new ethers.Wallet(key, provider);
  const signer = new NonceManager(wallet);
  return [alfajores, kovan, fuji, mumbai].map((partial) => {
    partial.overrides = {};
    partial.confirmations = 1;
    return { ...partial, signer };
  });
};
