import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

// =============================================================================
// MerkleTreeHook: InsertedIntoTree Event Handler
// =============================================================================

ponder.on('MerkleTreeHook:InsertedIntoTree', async ({ event, context }) => {
  const { chainId, name: chainName } = context.network;
  const { messageId, index } = event.args;

  // Track in Ponder's minimal schema for monitoring
  // The MerkleTreeHook events are primarily useful for validator checkpointing
  // but we track them for completeness
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
