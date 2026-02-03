import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

import { getAdapter } from '../db/adapter.js';
import { updateProgress } from '../utils/progress.js';

// =============================================================================
// MerkleTreeHook: InsertedIntoTree Event Handler
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
ponder.on(
  'MerkleTreeHook:InsertedIntoTree',
  async ({ event, context }: any) => {
    const adapter = getAdapter();
    const { id: chainId, name: chainName } = context.chain;
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

    // Skip if missing transactionIndex
    if (event.transaction.transactionIndex == null) {
      console.warn(
        `No transactionIndex for MerkleTreeInsertion in block ${event.block.number}, skipping`,
      );
      return;
    }

    // Store transaction
    const txId = await adapter.storeTransaction(
      blockId,
      {
        hash: event.transaction.hash,
        transactionIndex: event.transaction.transactionIndex,
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
        gasUsed: event.transactionReceipt?.gasUsed ?? 0n,
        cumulativeGasUsed: event.transactionReceipt?.cumulativeGasUsed ?? 0n,
        effectiveGasPrice: event.transactionReceipt?.effectiveGasPrice ?? 0n,
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

    // Update progress tracking
    await updateProgress(
      chainId,
      chainName,
      Number(event.block.number),
      context.client,
    );
  },
);
