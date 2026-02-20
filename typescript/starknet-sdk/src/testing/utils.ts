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
  const rpcUrls = metadata.rpcUrls?.map(({ http }) => http) ?? [];
  assert(rpcUrls.length > 0, 'Expected Starknet rpc urls to be defined');
  return StarknetProvider.connect(rpcUrls, metadata.chainId, { metadata });
}

export async function createSigner(
  privateKey: string = TEST_STARKNET_PRIVATE_KEY,
  accountAddress: string = TEST_STARKNET_ACCOUNT_ADDRESS,
  metadata: TestChainMetadata = TEST_STARKNET_CHAIN_METADATA,
): Promise<StarknetSigner> {
  const rpcUrls = metadata.rpcUrls?.map(({ http }) => http) ?? [];
  assert(rpcUrls.length > 0, 'Expected Starknet rpc urls to be defined');
  return (await StarknetSigner.connectWithSigner(rpcUrls, privateKey, {
    metadata,
    accountAddress,
  })) as StarknetSigner;
}
