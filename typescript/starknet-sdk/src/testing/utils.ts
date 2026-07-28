import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';

import {
  TEST_STARKNET_ACCOUNT_ADDRESS,
  TEST_STARKNET_CHAIN_METADATA,
  TEST_STARKNET_PRIVATE_KEY,
} from './constants.js';

export function createProvider(
  metadata: TestChainMetadata = TEST_STARKNET_CHAIN_METADATA,
): StarknetProvider {
  return StarknetProvider.connect(metadata);
}

export async function createSigner(
  privateKey: string = TEST_STARKNET_PRIVATE_KEY,
  accountAddress: string = TEST_STARKNET_ACCOUNT_ADDRESS,
  metadata: TestChainMetadata = TEST_STARKNET_CHAIN_METADATA,
): Promise<StarknetSigner> {
  const signer = await StarknetSigner.connectWithSigner(metadata, privateKey, {
    accountAddress,
  });
  assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
  return signer;
}
