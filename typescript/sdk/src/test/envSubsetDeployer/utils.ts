import { Wallet } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

export const CELO_DERIVATION_PATH = "m/44'/52752'/0'/0/0";

export function getAlfajoresSigner() {
  console.info('Getting signer');
  const mnemonic = utils.safelyAccessEnvVar('MNEMONIC');
  if (!mnemonic) throw new Error('No MNEMONIC provided in env');
  const wallet = Wallet.fromMnemonic(mnemonic, CELO_DERIVATION_PATH);
  console.info('Signer and provider ready');
  return wallet;
}
