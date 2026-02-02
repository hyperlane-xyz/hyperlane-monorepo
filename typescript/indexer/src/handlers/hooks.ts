import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

import { getAdapter } from '../db/adapter.js';

// =============================================================================
// MerkleTreeHook: InsertedIntoTree Event Handler
// =============================================================================

ponder.on('MerkleTreeHook:InsertedIntoTree', async ({ event, context }) => {
  const adapter = getAdapter();
  const { chainId, name: chainName } = context.network;
  const merkleTreeHookAddress = context.contracts.MerkleTreeHook
    .address as `0x${string}`;
  const { messageId, index } = event.args;

  // Store block
  const blockId = await adapter.storeBlock(chainId, {
    hash: event.block.hash,
    number: event.block.number,
    timestamp: event.block.timestamp,
  });

  if (!blockId) {
    console.error(`Failed to store block for ${chainName}`);
    return;
  }

  // Skip if no transaction receipt or missing transactionIndex
  if (
    !event.transactionReceipt ||
    event.transactionReceipt.transactionIndex == null
  ) {
    console.warn(
      `No transaction receipt/index for MerkleTreeInsertion in block ${event.block.number}, skipping`,
    );
    return;
  }

  // Store transaction
  const txId = await adapter.storeTransaction(
    blockId,
    {
      hash: event.transaction.hash,
      transactionIndex: event.transactionReceipt.transactionIndex,
      from: event.transaction.from,
      to: event.transaction.to,
      gas: event.transaction.gas,
      gasPrice: event.transaction.gasPrice,
      maxFeePerGas: event.transaction.maxFeePerGas,
      maxPriorityFeePerGas: event.transaction.maxPriorityFeePerGas,
      nonce: event.transaction.nonce,
      input: event.transaction.input,
    },
    {
      gasUsed: event.transactionReceipt.gasUsed,
      cumulativeGasUsed: event.transactionReceipt.cumulativeGasUsed,
      effectiveGasPrice: event.transactionReceipt.effectiveGasPrice,
      logs: [],
    },
  );

  if (!txId) {
    console.error(`Failed to store transaction for ${chainName}`);
    return;
  }

  // Store MerkleTreeInsertion (for validator checkpoint signing)
  await adapter.storeMerkleTreeInsertion(
    chainId,
    merkleTreeHookAddress,
    {
      messageId,
      leafIndex: index,
      logIndex: event.log.logIndex,
    },
    txId,
  );

  // Track in Ponder's minimal schema for monitoring
  await context.db.insert(ponderSchema.indexedEvent).values({
    id: `merkle-${messageId}-${index}`,
    chainId,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    eventType: 'InsertedIntoTree',
    timestamp: Number(event.block.timestamp),
  });

  console.log(
    `Indexed InsertedIntoTree on ${chainName}: msg=${messageId} index=${index} (block ${event.block.number})`,
  );
});
