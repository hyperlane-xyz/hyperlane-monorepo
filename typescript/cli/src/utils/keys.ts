import { input } from '@inquirer/prompts';
import { ethers, providers } from 'ethers';
import { Wallet } from 'zksync-ethers';

import { impersonateAccount } from '@hyperlane-xyz/sdk';
import { Address, ensure0x } from '@hyperlane-xyz/utils';

const ETHEREUM_ADDRESS_LENGTH = 42;

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
}): Promise<{ key?: string; signer: Wallet }> {
  key ||= await retrieveKey(skipConfirmation);
  const signer = privateKeyToSigner(key);
  return { key, signer };
}

/**
 * Retrieves an impersonated signer for the current command-context.
 * @returns the impersonated signer
 */
export async function getImpersonatedSigner({
  fromAddress,
  key,
  skipConfirmation,
}: {
  fromAddress?: Address;
  key?: string;
  skipConfirmation?: boolean;
}) {
  if (!fromAddress) {
    const { signer } = await getSigner({ key, skipConfirmation });
    fromAddress = signer.address;
  }
  return {
    impersonatedKey: fromAddress,
    impersonatedSigner: await addressToImpersonatedSigner(fromAddress),
  };
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
 * Generates a signer from an address.
 * @param address an EOA address
 * @returns a signer for the address
 */
async function addressToImpersonatedSigner(
  address: Address,
): Promise<providers.JsonRpcSigner> {
  if (!address) throw new Error('No address provided');

  const formattedKey = address.trim().toLowerCase();
  if (address.length != ETHEREUM_ADDRESS_LENGTH)
    throw new Error('Invalid address length.');
  else if (ethers.utils.isHexString(ensure0x(formattedKey)))
    return impersonateAccount(address);
  else throw new Error('Invalid address format');
}

/**
 * Generates a signer from a private key.
 * @param key a private key
 * @returns a signer for the private key
 */
function privateKeyToSigner(key: string): Wallet {
  if (!key) throw new Error('No private key provided');

  const formattedKey = key.trim().toLowerCase();
  if (ethers.utils.isHexString(ensure0x(formattedKey)))
    return new Wallet(ensure0x(formattedKey));
  else if (formattedKey.split(' ').length >= 6)
    return Wallet.fromMnemonic(formattedKey);
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
