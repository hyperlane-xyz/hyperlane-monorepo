import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

import { getAdapter } from '../db/adapter.js';
import { extractAddress, parseMessage } from '../types/events.js';

/**
 * Track the last seen DispatchId for correlating with Dispatch events.
 * Ponder processes events in order within a transaction.
 */
const pendingDispatchIds = new Map<string, `0x${string}`>();

/**
 * Track the last seen ProcessId for correlating with Process events.
 */
const pendingProcessIds = new Map<string, `0x${string}`>();

/**
 * Generate a unique key for correlating events within a transaction.
 */
function txKey(
  chainId: number,
  txHash: `0x${string}`,
  logIndex: number,
): string {
  return `${chainId}-${txHash}-${logIndex}`;
}

// =============================================================================
// Dispatch Event Handler
// =============================================================================

ponder.on('Mailbox:Dispatch', async ({ event, context }) => {
  const adapter = getAdapter();
  const { chainId, name: chainName } = context.network;
  const mailboxAddress = context.contracts.Mailbox.address as `0x${string}`;

  const { sender, destination, recipient, message } = event.args;

  // Parse the full message to get nonce
  const parsed = parseMessage(message);

  // Get the message ID from the pending DispatchId event
  // DispatchId is emitted immediately after Dispatch in the same tx
  const dispatchIdKey = txKey(
    chainId,
    event.transaction.hash,
    event.log.logIndex + 1,
  );
  let messageId = pendingDispatchIds.get(dispatchIdKey);

  // If DispatchId hasn't been processed yet, compute from message
  // In practice, we rely on DispatchId event
  if (!messageId) {
    // Wait for DispatchId - it will be processed next
    // Store this event's data for later correlation
    console.warn(
      `DispatchId not found for Dispatch at ${chainName} block ${event.block.number}`,
    );
    return;
  }

  // Clean up
  pendingDispatchIds.delete(dispatchIdKey);

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

  // Store transaction
  const txId = await adapter.storeTransaction(
    blockId,
    {
      hash: event.transaction.hash,
      transactionIndex: event.transactionReceipt!.transactionIndex,
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
      gasUsed: event.transactionReceipt!.gasUsed,
      cumulativeGasUsed: event.transactionReceipt!.cumulativeGasUsed,
      effectiveGasPrice: event.transactionReceipt!.effectiveGasPrice,
      logs: event.transactionReceipt!.logs.map(
        (log: {
          logIndex: number;
          address: `0x${string}`;
          topics: readonly `0x${string}`[];
          data: `0x${string}`;
        }) => ({
          logIndex: log.logIndex,
          address: log.address,
          topics: log.topics,
          data: log.data,
        }),
      ),
    },
  );

  if (!txId) {
    console.error(`Failed to store transaction for ${chainName}`);
    return;
  }

  // Store all transaction logs (FR-9)
  if (event.transactionReceipt?.logs) {
    await adapter.storeTransactionLogs(
      txId,
      event.transactionReceipt.logs.map(
        (log: {
          logIndex: number;
          address: `0x${string}`;
          topics: readonly `0x${string}`[];
          data: `0x${string}`;
        }) => ({
          logIndex: log.logIndex,
          address: log.address,
          topics: log.topics,
          data: log.data,
        }),
      ),
    );
  }

  // Store the dispatch event (message)
  await adapter.storeDispatch(
    chainId,
    mailboxAddress,
    {
      messageId,
      sender: extractAddress(parsed.sender),
      destination: parsed.destination,
      recipient: parsed.recipient,
      message: parsed.body,
      nonce: parsed.nonce,
      version: parsed.version,
      logIndex: event.log.logIndex,
    },
    txId,
  );

  // Store raw dispatch (lightweight record)
  await adapter.storeRawDispatch(
    chainId,
    mailboxAddress,
    {
      messageId,
      sender: extractAddress(parsed.sender),
      destination: parsed.destination,
      recipient: parsed.recipient,
      message: parsed.body,
      nonce: parsed.nonce,
      version: parsed.version,
      logIndex: event.log.logIndex,
    },
    {
      hash: event.block.hash,
      number: event.block.number,
      timestamp: event.block.timestamp,
    },
    event.transaction.hash,
  );

  // Track in Ponder's minimal schema for monitoring
  await context.db.insert(ponderSchema.indexedEvent).values({
    id: `dispatch-${messageId}`,
    chainId,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    eventType: 'Dispatch',
    timestamp: Number(event.block.timestamp),
  });

  console.log(
    `Indexed Dispatch on ${chainName}: ${messageId} (block ${event.block.number})`,
  );
});

// =============================================================================
// DispatchId Event Handler
// =============================================================================

ponder.on('Mailbox:DispatchId', async ({ event, context }) => {
  const { chainId } = context.network;
  const { messageId } = event.args;

  // Store the message ID for correlation with the preceding Dispatch event
  // DispatchId is emitted immediately after Dispatch
  const key = txKey(chainId, event.transaction.hash, event.log.logIndex);
  pendingDispatchIds.set(key, messageId);
});

// =============================================================================
// Process Event Handler
// =============================================================================

ponder.on('Mailbox:Process', async ({ event, context }) => {
  const adapter = getAdapter();
  const { chainId, name: chainName } = context.network;
  const mailboxAddress = context.contracts.Mailbox.address as `0x${string}`;

  const { origin, sender, recipient } = event.args;

  // Get the message ID from the pending ProcessId event
  const processIdKey = txKey(
    chainId,
    event.transaction.hash,
    event.log.logIndex + 1,
  );
  let messageId = pendingProcessIds.get(processIdKey);

  if (!messageId) {
    console.warn(
      `ProcessId not found for Process at ${chainName} block ${event.block.number}`,
    );
    return;
  }

  // Clean up
  pendingProcessIds.delete(processIdKey);

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

  // Store transaction
  const txId = await adapter.storeTransaction(
    blockId,
    {
      hash: event.transaction.hash,
      transactionIndex: event.transactionReceipt!.transactionIndex,
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
      gasUsed: event.transactionReceipt!.gasUsed,
      cumulativeGasUsed: event.transactionReceipt!.cumulativeGasUsed,
      effectiveGasPrice: event.transactionReceipt!.effectiveGasPrice,
      logs: event.transactionReceipt!.logs.map(
        (log: {
          logIndex: number;
          address: `0x${string}`;
          topics: readonly `0x${string}`[];
          data: `0x${string}`;
        }) => ({
          logIndex: log.logIndex,
          address: log.address,
          topics: log.topics,
          data: log.data,
        }),
      ),
    },
  );

  if (!txId) {
    console.error(`Failed to store transaction for ${chainName}`);
    return;
  }

  // Store delivery
  await adapter.storeDelivery(
    chainId,
    mailboxAddress,
    {
      messageId,
      origin,
      sender,
      recipient,
    },
    txId,
    event.log.logIndex,
  );

  // Track in Ponder's minimal schema for monitoring
  await context.db.insert(ponderSchema.indexedEvent).values({
    id: `process-${messageId}`,
    chainId,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    eventType: 'Process',
    timestamp: Number(event.block.timestamp),
  });

  console.log(
    `Indexed Process on ${chainName}: ${messageId} (block ${event.block.number})`,
  );
});

// =============================================================================
// ProcessId Event Handler
// =============================================================================

ponder.on('Mailbox:ProcessId', async ({ event, context }) => {
  const { chainId } = context.network;
  const { messageId } = event.args;

  // Store the message ID for correlation with the preceding Process event
  const key = txKey(chainId, event.transaction.hash, event.log.logIndex);
  pendingProcessIds.set(key, messageId);
});
