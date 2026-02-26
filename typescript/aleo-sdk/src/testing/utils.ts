import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

import { AleoSigner } from '../clients/signer.js';
import { type AleoReceipt, type AleoTransaction } from '../utils/types.js';

import {
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from './constants.js';

/**
 * Creates an AleoSigner connected to the test devnode
 *
 * @param privateKey - Private key (defaults to TEST_ALEO_PRIVATE_KEY)
 * @param chainMetadata - Optional chain metadata (defaults to TEST_ALEO_CHAIN_METADATA)
 * @returns Connected AleoSigner instance
 */
export async function createSigner(
  privateKey: string = TEST_ALEO_PRIVATE_KEY,
  chainMetadata: TestChainMetadata = TEST_ALEO_CHAIN_METADATA,
): Promise<AltVM.ISigner<AleoTransaction, AleoReceipt>> {
  return AleoSigner.connectWithSigner([chainMetadata.rpcUrl], privateKey, {
    metadata: chainMetadata,
  });
}

/**
 * Creates multiple signers with different private keys
 *
 * @param privateKeys - Array of private keys
 * @param chainMetadata - Optional chain metadata (defaults to TEST_ALEO_CHAIN_METADATA)
 * @returns Array of connected AleoSigner instances
 */
export async function createSigners(
  privateKeys: string[],
  chainMetadata: TestChainMetadata = TEST_ALEO_CHAIN_METADATA,
): Promise<AltVM.ISigner<AleoTransaction, AleoReceipt>[]> {
  return Promise.all(privateKeys.map((pk) => createSigner(pk, chainMetadata)));
}
