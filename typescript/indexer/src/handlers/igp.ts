import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

import { getAdapter } from '../db/adapter.js';

// =============================================================================
// GasPayment Event Handler
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
ponder.on(
  'InterchainGasPaymaster:GasPayment',
  async ({ event, context }: any) => {
    const adapter = getAdapter();
    const { chainId, name: chainName } = context.network;
    const igpAddress = context.contracts.InterchainGasPaymaster
      .address as `0x${string}`;

    const { messageId, destinationDomain, gasAmount, payment } = event.args;

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
        `No transactionIndex for GasPayment in block ${event.block.number}, skipping`,
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

    // Get origin domain ID from chainId
    const originDomainId = await adapter.getDomainId(chainId);
    if (!originDomainId) {
      console.warn(`No domain found for chainId ${chainId}`);
      return;
    }

    // Store gas payment
    await adapter.storeGasPayment(
      chainId,
      originDomainId,
      igpAddress,
      {
        messageId,
        destinationDomain,
        gasAmount,
        payment,
      },
      txId,
      event.log.logIndex,
    );

    // Track in Ponder's minimal schema for monitoring
    await context.db.insert(ponderSchema.indexedEvent).values({
      id: `gas-${messageId}-${event.transaction.hash}-${event.log.logIndex}`,
      chainId,
      blockNumber: event.block.number,
      transactionHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      eventType: 'GasPayment',
      timestamp: Number(event.block.timestamp),
    });

    console.log(
      `Indexed GasPayment on ${chainName}: msg=${messageId} payment=${payment} (block ${event.block.number})`,
    );
  },
);
