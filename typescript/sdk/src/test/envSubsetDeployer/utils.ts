import { Wallet } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@abacus-network/celo-ethers-provider';

export const ALFAJORES_FORNO = 'https://alfajores-forno.celo-testnet.org';
export const CELO_DERIVATION_PATH = "m/44'/52752'/0'/0/0";

export function getAlfajoresSigner() {
  console.info('Getting signer');
  const provider = new StaticCeloJsonRpcProvider(ALFAJORES_FORNO);
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) throw new Error('No MNEMONIC provided in env');
  const wallet = Wallet.fromMnemonic(mnemonic, CELO_DERIVATION_PATH).connect(
    provider,
  );
  console.info('Signer and provider ready');
  return wallet;
}
