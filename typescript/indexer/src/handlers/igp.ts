import { ponder } from 'ponder:registry';
import * as ponderSchema from 'ponder:schema';

import { getAdapter } from '../db/adapter.js';
import { checkAndHandleReorg } from '../db/reorg.js';
import { getLogger } from '../utils/logger.js';
import { updateProgress } from '../utils/progress.js';

// =============================================================================
// GasPayment Event Handler
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
ponder.on(
  'InterchainGasPaymaster:GasPayment',
  async ({ event, context }: any) => {
    const adapter = getAdapter();
    const { id: chainId, name: chainName } = context.chain;
    const igpAddress = context.contracts.InterchainGasPaymaster
      .address as `0x${string}`;

    const { messageId, destinationDomain, gasAmount, payment } = event.args;

    // Check for reorg before storing block data
    await checkAndHandleReorg(
      chainId,
      Number(event.block.number),
      event.block.hash,
    );

    // Store block
    const blockId = await adapter.storeBlock(chainId, {
      hash: event.block.hash,
      number: event.block.number,
      timestamp: event.block.timestamp,
    });

    if (!blockId) {
      getLogger().error({ chain: chainName }, 'Failed to store block');
      return;
    }

    // Skip if missing transactionIndex
    if (event.transaction.transactionIndex == null) {
      getLogger().warn(
        { chain: chainName, block: event.block.number },
        'No transactionIndex for GasPayment, skipping',
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
      getLogger().error({ chain: chainName }, 'Failed to store transaction');
      return;
    }

    // Get origin domain ID from chainId
    const originDomainId = await adapter.getDomainId(chainId);
    if (!originDomainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return;
    }

    // Check if destination domain exists
    const destDomainExists = await adapter.domainExists(destinationDomain);
    if (!destDomainExists) {
      getLogger().warn(
        {
          destination: destinationDomain,
          messageId,
          origin: chainName,
          block: event.block.number,
        },
        'Unknown destination domain for GasPayment',
      );
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

    // Update progress tracking
    await updateProgress(
      chainId,
      chainName,
      Number(event.block.number),
      context.client,
    );
  },
);
