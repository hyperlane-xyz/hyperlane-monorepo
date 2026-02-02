import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

import { getAdapter } from '../db/adapter.js';
import {
  computeMessageId,
  extractAddress,
  parseMessage,
} from '../types/events.js';

/**
 * Pending Process event data waiting for ProcessId correlation.
 * Process event runs first (at logIndex N), ProcessId runs second (at logIndex N+1).
 * Process stores data here, ProcessId looks it up and triggers the actual storage.
 */
interface PendingProcessData {
  chainId: number;
  chainName: string;
  mailboxAddress: `0x${string}`;
  origin: number;
  sender: `0x${string}`;
  recipient: `0x${string}`;
  block: {
    hash: `0x${string}`;
    number: bigint;
    timestamp: bigint;
  };
  transaction: {
    hash: `0x${string}`;
    from: `0x${string}`;
    to: `0x${string}` | null;
    gas: bigint;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    nonce: number;
    input: `0x${string}`;
  };
  transactionReceipt: {
    transactionIndex: number;
    gasUsed: bigint;
    cumulativeGasUsed: bigint;
    effectiveGasPrice: bigint;
    logs: Array<{
      logIndex: number;
      address: `0x${string}`;
      topics: readonly `0x${string}`[];
      data: `0x${string}`;
    }>;
  };
  logIndex: number;
}

const pendingProcessEvents = new Map<string, PendingProcessData>();

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

  const { message } = event.args;

  // Parse the full message to get nonce
  const parsed = parseMessage(message);

  // Compute message ID directly from message bytes (keccak256 hash)
  const messageId = computeMessageId(message);

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
      `No transaction receipt/index for Dispatch in block ${event.block.number}, skipping`,
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
      logs: event.transactionReceipt.logs.map(
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

ponder.on('Mailbox:DispatchId', async () => {
  // No-op: We compute messageId directly from message bytes in Dispatch handler
  // This handler is kept for completeness but doesn't need to do anything
});

// =============================================================================
// Process Event Handler
// =============================================================================

ponder.on('Mailbox:Process', async ({ event, context }) => {
  const { chainId, name: chainName } = context.network;
  const mailboxAddress = context.contracts.Mailbox.address as `0x${string}`;

  const { origin, sender, recipient } = event.args;

  // Skip if no transaction receipt or missing transactionIndex
  if (
    !event.transactionReceipt ||
    event.transactionReceipt.transactionIndex == null
  ) {
    console.warn(
      `No transaction receipt/index for Process in block ${event.block.number}, skipping`,
    );
    return;
  }

  // Store pending data for ProcessId to pick up
  // Process runs at logIndex N, ProcessId runs at logIndex N+1
  const key = txKey(chainId, event.transaction.hash, event.log.logIndex);
  pendingProcessEvents.set(key, {
    chainId,
    chainName,
    mailboxAddress,
    origin,
    sender,
    recipient,
    block: {
      hash: event.block.hash as `0x${string}`,
      number: event.block.number,
      timestamp: event.block.timestamp,
    },
    transaction: {
      hash: event.transaction.hash,
      from: event.transaction.from,
      to: event.transaction.to,
      gas: event.transaction.gas,
      gasPrice: event.transaction.gasPrice,
      maxFeePerGas: event.transaction.maxFeePerGas,
      maxPriorityFeePerGas: event.transaction.maxPriorityFeePerGas,
      nonce: event.transaction.nonce,
      input: event.transaction.input,
    },
    transactionReceipt: {
      transactionIndex: event.transactionReceipt.transactionIndex,
      gasUsed: event.transactionReceipt.gasUsed,
      cumulativeGasUsed: event.transactionReceipt.cumulativeGasUsed,
      effectiveGasPrice: event.transactionReceipt.effectiveGasPrice,
      logs: event.transactionReceipt.logs.map(
        (log: {
          logIndex: number;
          address: `0x${string}`;
          topics: readonly `0x${string}`[];
          data: `0x${string}`;
        }) => ({
          logIndex: log.logIndex,
          address: log.address,
          topics: [...log.topics] as `0x${string}`[],
          data: log.data,
        }),
      ),
    },
    logIndex: event.log.logIndex,
  });
});

// =============================================================================
// ProcessId Event Handler
// =============================================================================

ponder.on('Mailbox:ProcessId', async ({ event, context }) => {
  const adapter = getAdapter();
  const { chainId, name: chainName } = context.network;
  const { messageId } = event.args;

  // Look up the pending Process event data (Process runs at logIndex-1)
  const processKey = txKey(
    chainId,
    event.transaction.hash,
    event.log.logIndex - 1,
  );
  const processData = pendingProcessEvents.get(processKey);

  if (!processData) {
    console.warn(
      `Process not found for ProcessId at ${chainName} block ${event.block.number}`,
    );
    return;
  }

  // Clean up
  pendingProcessEvents.delete(processKey);

  // Store block
  const blockId = await adapter.storeBlock(processData.chainId, {
    hash: processData.block.hash,
    number: processData.block.number,
    timestamp: processData.block.timestamp,
  });

  if (!blockId) {
    console.error(`Failed to store block for ${processData.chainName}`);
    return;
  }

  // Store transaction
  const txId = await adapter.storeTransaction(
    blockId,
    {
      hash: processData.transaction.hash,
      transactionIndex: processData.transactionReceipt.transactionIndex,
      from: processData.transaction.from,
      to: processData.transaction.to,
      gas: processData.transaction.gas,
      gasPrice: processData.transaction.gasPrice,
      maxFeePerGas: processData.transaction.maxFeePerGas,
      maxPriorityFeePerGas: processData.transaction.maxPriorityFeePerGas,
      nonce: processData.transaction.nonce,
      input: processData.transaction.input,
    },
    {
      gasUsed: processData.transactionReceipt.gasUsed,
      cumulativeGasUsed: processData.transactionReceipt.cumulativeGasUsed,
      effectiveGasPrice: processData.transactionReceipt.effectiveGasPrice,
      logs: processData.transactionReceipt.logs,
    },
  );

  if (!txId) {
    console.error(`Failed to store transaction for ${processData.chainName}`);
    return;
  }

  // Store delivery
  await adapter.storeDelivery(
    processData.chainId,
    processData.mailboxAddress,
    {
      messageId,
      origin: processData.origin,
      sender: processData.sender,
      recipient: processData.recipient,
    },
    txId,
    processData.logIndex,
  );

  // Track in Ponder's minimal schema for monitoring
  await context.db.insert(ponderSchema.indexedEvent).values({
    id: `process-${messageId}`,
    chainId: processData.chainId,
    blockNumber: processData.block.number,
    transactionHash: processData.transaction.hash,
    logIndex: processData.logIndex,
    eventType: 'Process',
    timestamp: Number(processData.block.timestamp),
  });

  console.log(
    `Indexed Process on ${processData.chainName}: ${messageId} (block ${processData.block.number})`,
  );
});
