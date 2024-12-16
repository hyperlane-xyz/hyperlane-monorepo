import { input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { ensure0x } from '@hyperlane-xyz/utils';

/**
 * Retrieves a signer for the current command-context.
 * @returns the signer
 */
export async function getSigner({
  key,
  skipConfirmation,
}: {
  key?: string;
  skipConfirmation?: boolean;
}) {
  key ||= await retrieveKey(skipConfirmation);
  const signer = privateKeyToSigner(key);
  return { key, signer };
}

/**
 * Verifies the specified signer is valid.
 * @param signer the signer to verify
 */
export function assertSigner(signer: ethers.Signer) {
  if (!signer || !ethers.Signer.isSigner(signer))
    throw new Error('Signer is invalid');
}

/**
 * Generates a signer from a private key.
 * @param key a private key
 * @returns a signer for the private key
 */
function privateKeyToSigner(key: string): ethers.Wallet {
  if (!key) throw new Error('No private key provided');

  const formattedKey = key.trim().toLowerCase();
  if (ethers.utils.isHexString(ensure0x(formattedKey)))
    return new ethers.Wallet(ensure0x(formattedKey));
  else if (formattedKey.split(' ').length >= 6)
    return ethers.Wallet.fromMnemonic(formattedKey);
  else throw new Error('Invalid private key format');
}

async function retrieveKey(
  skipConfirmation: boolean | undefined,
): Promise<string> {
  if (skipConfirmation) throw new Error(`No private key provided`);
  else
    return input({
      message: `Please enter private key or use the HYP_KEY environment variable.`,
    });
}
