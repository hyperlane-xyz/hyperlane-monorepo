import { Wallet } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@hyperlane-xyz/celo-ethers-provider';
import { utils } from '@hyperlane-xyz/utils';

export const ALFAJORES_FORNO = 'https://alfajores-forno.celo-testnet.org';
export const CELO_DERIVATION_PATH = "m/44'/52752'/0'/0/0";

export function getAlfajoresSigner() {
  console.info('Getting signer');
  const provider = getAlfajoresProvider();
  const mnemonic = utils.safelyAccessEnvVar('MNEMONIC');
  if (!mnemonic) throw new Error('No MNEMONIC provided in env');
  const wallet = Wallet.fromMnemonic(mnemonic, CELO_DERIVATION_PATH).connect(
    provider,
  );
  console.info('Signer and provider ready');
  return wallet;
}

export function getAlfajoresProvider() {
  console.info('Getting provider');
  return new StaticCeloJsonRpcProvider(ALFAJORES_FORNO);
}
