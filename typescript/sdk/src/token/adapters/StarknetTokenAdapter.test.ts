/* eslint-disable no-console */
import { cairo } from 'starknet';

import { addressToBytes } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { TransferRemoteParams } from './ITokenAdapter.js';
import { StarknetHypSyntheticAdapter } from './StarknetTokenAdapter.js';

// Example addresses - replace with actual addresses for your test environment
const testAddresses = {
  warpRouter:
    '0x05a5b7d2a9be4c41cdc522b42cd787ea4d142bf1dc8619a47be2196c0b3ad1a0', // Replace with actual warp router address
};

const multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider();

const adapter = new StarknetHypSyntheticAdapter(
  'starknetdevnet', // Replace with actual chain name
  multiProvider,
  testAddresses,
);

// Test parameters
const params = {
  weiAmountOrId: '3000000', // 0.003
  destination: 1399811150, // Example destination domain
  recipient: 'ApMsTRbsbBpsmzpht4JpzudaBEef4AqW1GfnEf6az6h9', // Replace with actual recipient address
  interchainGas: {
    amount: BigInt('0'), // 0
  },
};

export async function runTest(params: TransferRemoteParams) {
  try {
    // Get the transaction data
    const tx = await adapter.populateTransferRemoteTx(params);

    // Log the transaction details
    console.log('calldata:', tx.calldata);
  } catch (error) {
    console.error('Error generating transaction:', error);
  }
}

export async function runTests() {
  await runTest(params);
  await runTest({
    ...params,
    interchainGas: {
      amount: BigInt('1000000000000000000'), // 1 STARK
    },
  });

  await runTest({
    ...params,
    recipient:
      '0x7e49f666e9b7832b69ca6fbdc36cf0d4acbe94dbe945bcbe7b41ec8dfadc00b2',
  });

  const recipientBigInt = new DataView(
    addressToBytes('ApMsTRbsbBpsmzpht4JpzudaBEef4AqW1GfnEf6az6h9').buffer,
    0,
  ).getBigUint64(0, true);
  console.log(cairo.uint256(recipientBigInt));
}

runTests().catch(console.error);
