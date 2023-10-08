import { ethers } from 'ethers';

import { ensure0x } from '@hyperlane-xyz/utils';

export function keyToSigner(key: string) {
  if (!key) throw new Error('No key provided');
  const formattedKey = key.trim().toLowerCase();
  if (ethers.utils.isHexString(ensure0x(formattedKey)))
    return new ethers.Wallet(ensure0x(formattedKey));
  else if (formattedKey.split(' ').length >= 6)
    return ethers.Wallet.fromMnemonic(formattedKey);
  else throw new Error('Invalid key format');
}

export function assertSigner(signer: ethers.Signer) {
  if (!signer || !ethers.Signer.isSigner(signer))
    throw new Error('Signer is invalid');
}
