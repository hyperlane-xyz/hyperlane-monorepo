import { and, eq } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { getLogger } from '../utils/logger.js';

import * as schema from './schema.js';

/**
 * Domain ID cache for lookups by chain ID.
 * Populated on first use from database.
 */
const domainCache = new Map<number, number>();

export interface BlockData {
  hash: `0x${string}`;
  number: bigint;
  timestamp: bigint;
}

export interface TransactionData {
  hash: `0x${string}`;
  transactionIndex: number; // Position in block (for LogMeta)
  from: `0x${string}`;
  to: `0x${string}` | null;
  gas: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce: number;
  input: `0x${string}`;
}

export interface TransactionReceiptData {
  gasUsed: bigint;
  cumulativeGasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: LogData[];
}

export interface LogData {
  logIndex: number;
  address: `0x${string}`;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}

export interface DispatchEventData {
  messageId: `0x${string}`;
  sender: `0x${string}`;
  destination: number;
  recipient: `0x${string}`;
  message: `0x${string}`;
  nonce: number;
  version: number; // Hyperlane message version (for HyperlaneMessage)
  logIndex: number; // Log index in tx (for LogMeta)
}

export interface ProcessEventData {
  messageId: `0x${string}`;
  origin: number;
  sender: `0x${string}`;
  recipient: `0x${string}`;
}

export interface GasPaymentEventData {
  messageId: `0x${string}`;
  destinationDomain: number;
  gasAmount: bigint;
  payment: bigint;
}

export interface MerkleTreeInsertionEventData {
  messageId: `0x${string}`;
  leafIndex: number;
  logIndex: number; // Log index in tx (for LogMeta)
}

/**
 * Database adapter for writing to ponder_* tables.
 * Mirrors the scraper schema for comparison purposes.
 */
export class PonderDbAdapter {
  private db: NodePgDatabase<typeof schema>;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 20,
    });
    this.db = drizzle(this.pool, { schema });
  }

  /**
   * Get domain ID from chain ID. Caches results.
   */
  async getDomainId(chainId: number): Promise<number | undefined> {
    if (domainCache.has(chainId)) {
      return domainCache.get(chainId);
    }

    const result = await this.db
      .select({ id: schema.domain.id })
      .from(schema.domain)
      .where(eq(schema.domain.chainId, chainId))
      .limit(1);

    if (result.length > 0) {
      domainCache.set(chainId, result[0].id);
      return result[0].id;
    }
    return undefined;
  }

  /**
   * Check if a domain exists by its Hyperlane domain ID.
   * Returns false for domain IDs > INTEGER max (can't exist in scraper's domain table).
   */
  async domainExists(domainId: number): Promise<boolean> {
    // Domain IDs > 2^31-1 can't exist in domain table (INTEGER type)
    const MAX_INT32 = 2147483647;
    if (domainId > MAX_INT32) {
      return false;
    }

    const result = await this.db
      .select({ id: schema.domain.id })
      .from(schema.domain)
      .where(eq(schema.domain.id, domainId))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Store or retrieve a block. Returns block ID.
   */
  async storeBlock(
    chainId: number,
    block: BlockData,
  ): Promise<number | undefined> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return undefined;
    }

    // Check if block already exists
    const existing = await this.db
      .select({ id: schema.ponderBlock.id })
      .from(schema.ponderBlock)
      .where(eq(schema.ponderBlock.hash, hexToBuffer(block.hash)))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    // Insert new block
    const result = await this.db
      .insert(schema.ponderBlock)
      .values({
        domain: domainId,
        hash: hexToBuffer(block.hash),
        height: Number(block.number),
        timestamp: new Date(Number(block.timestamp) * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: schema.ponderBlock.id });

    if (result.length > 0) {
      return result[0].id;
    }

    // If insert returned nothing due to conflict, fetch existing
    const refetch = await this.db
      .select({ id: schema.ponderBlock.id })
      .from(schema.ponderBlock)
      .where(eq(schema.ponderBlock.hash, hexToBuffer(block.hash)))
      .limit(1);

    return refetch[0]?.id;
  }

  /**
   * Store or retrieve a transaction. Returns transaction ID.
   */
  async storeTransaction(
    blockId: number,
    tx: TransactionData,
    receipt: TransactionReceiptData,
  ): Promise<number | undefined> {
    // Check if transaction already exists
    const existing = await this.db
      .select({ id: schema.ponderTransaction.id })
      .from(schema.ponderTransaction)
      .where(eq(schema.ponderTransaction.hash, hexToBuffer(tx.hash)))
      .limit(1);

    if (existing.length > 0) {
      return existing[0].id;
    }

    // Insert new transaction
    const result = await this.db
      .insert(schema.ponderTransaction)
      .values({
        hash: hexToBuffer(tx.hash),
        blockId,
        transactionIndex: tx.transactionIndex,
        gasLimit: tx.gas.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
        maxFeePerGas: tx.maxFeePerGas?.toString(),
        gasPrice:
          tx.gasPrice?.toString() ?? receipt.effectiveGasPrice.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        nonce: tx.nonce,
        sender: hexToBuffer(tx.from),
        recipient: tx.to ? hexToBuffer(tx.to) : null,
        gasUsed: receipt.gasUsed.toString(),
        cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
        rawInputData: hexToBuffer(tx.input),
      })
      .onConflictDoNothing()
      .returning({ id: schema.ponderTransaction.id });

    if (result.length > 0) {
      return result[0].id;
    }

    // If insert returned nothing due to conflict, fetch existing
    const refetch = await this.db
      .select({ id: schema.ponderTransaction.id })
      .from(schema.ponderTransaction)
      .where(eq(schema.ponderTransaction.hash, hexToBuffer(tx.hash)))
      .limit(1);

    return refetch[0]?.id;
  }

  /**
   * Store all logs from a transaction (FR-9).
   * Uses raw SQL with hex literals for bytea to avoid UTF8 encoding issues.
   */
  async storeTransactionLogs(txId: number, logs: LogData[]): Promise<void> {
    if (logs.length === 0) return;

    for (const log of logs) {
      try {
        // Convert topics to PostgreSQL bytea array literal format
        const topicsLiteral = `{${log.topics.map((t) => `"\\\\x${t.slice(2)}"`).join(',')}}`;
        // Data as hex literal or NULL
        const dataHex =
          log.data && log.data.length > 2 ? `\\x${log.data.slice(2)}` : null;
        const addressHex = `\\x${log.address.slice(2)}`;

        await this.pool.query(
          `INSERT INTO ponder_transaction_log (tx_id, log_index, address, topics, data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [txId, log.logIndex, addressHex, topicsLiteral, dataHex],
        );
      } catch (err) {
        getLogger().warn(
          { txId, logIndex: log.logIndex, err },
          'Failed to store transaction log',
        );
      }
    }
  }

  /**
   * Store a Dispatch event (message).
   */
  async storeDispatch(
    chainId: number,
    mailboxAddress: `0x${string}`,
    event: DispatchEventData,
    txId: number,
  ): Promise<void> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return;
    }

    await this.db
      .insert(schema.ponderMessage)
      .values({
        msgId: hexToBuffer(event.messageId),
        version: event.version,
        origin: domainId,
        destination: event.destination,
        nonce: event.nonce,
        sender: hexToBuffer(event.sender),
        recipient: hexToBuffer(event.recipient),
        msgBody: hexToBuffer(event.message),
        originMailbox: hexToBuffer(mailboxAddress),
        originTxId: txId,
        logIndex: event.logIndex,
      })
      .onConflictDoNothing();
  }

  /**
   * Store a raw Dispatch event (lightweight record without FK).
   */
  async storeRawDispatch(
    chainId: number,
    mailboxAddress: `0x${string}`,
    event: DispatchEventData,
    block: BlockData,
    txHash: `0x${string}`,
  ): Promise<void> {
    const domainId = await this.getDomainId(chainId);

    await this.db
      .insert(schema.ponderRawMessageDispatch)
      .values({
        msgId: hexToBuffer(event.messageId),
        originTxHash: hexToBuffer(txHash),
        originBlockHash: hexToBuffer(block.hash),
        originBlockHeight: Number(block.number),
        nonce: event.nonce,
        originDomain: domainId ?? chainId,
        destinationDomain: event.destination,
        sender: hexToBuffer(event.sender),
        recipient: hexToBuffer(event.recipient),
        originMailbox: hexToBuffer(mailboxAddress),
      })
      .onConflictDoNothing();
  }

  /**
   * Store a Process event (message delivery).
   */
  async storeDelivery(
    chainId: number,
    mailboxAddress: `0x${string}`,
    event: ProcessEventData,
    txId: number,
    logIndex: number,
    sequence?: number,
  ): Promise<void> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return;
    }

    await this.db
      .insert(schema.ponderDeliveredMessage)
      .values({
        msgId: hexToBuffer(event.messageId),
        domain: domainId,
        destinationMailbox: hexToBuffer(mailboxAddress),
        destinationTxId: txId,
        logIndex,
        sequence: sequence ?? null,
      })
      .onConflictDoNothing();
  }

  /**
   * Store a GasPayment event.
   */
  async storeGasPayment(
    chainId: number,
    originDomain: number,
    igpAddress: `0x${string}`,
    event: GasPaymentEventData,
    txId: number,
    logIndex: number,
    sequence?: number,
  ): Promise<void> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return;
    }

    await this.db
      .insert(schema.ponderGasPayment)
      .values({
        domain: domainId,
        msgId: hexToBuffer(event.messageId),
        payment: event.payment.toString(),
        gasAmount: event.gasAmount.toString(),
        txId,
        logIndex,
        origin: originDomain,
        destination: event.destinationDomain,
        interchainGasPaymaster: hexToBuffer(igpAddress),
        sequence: sequence ?? null,
      })
      .onConflictDoNothing();
  }

  /**
   * Store a MerkleTreeInsertion event (for validator checkpoint signing).
   */
  async storeMerkleTreeInsertion(
    chainId: number,
    merkleTreeHookAddress: `0x${string}`,
    event: MerkleTreeInsertionEventData,
    txId: number,
  ): Promise<void> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return;
    }

    await this.db
      .insert(schema.ponderMerkleTreeInsertion)
      .values({
        domain: domainId,
        leafIndex: event.leafIndex,
        messageId: hexToBuffer(event.messageId),
        merkleTreeHook: hexToBuffer(merkleTreeHookAddress),
        txId,
        logIndex: event.logIndex,
      })
      .onConflictDoNothing();
  }

  /**
   * Record a reorg event (FR-5).
   */
  async recordReorg(
    chainId: number,
    reorgedBlockHeight: number,
    reorgedBlockHash: `0x${string}`,
    newBlockHash: `0x${string}`,
    affectedMsgIds: `0x${string}`[],
  ): Promise<void> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) {
      getLogger().warn({ chainId }, 'No domain found for chainId');
      return;
    }

    await this.db.insert(schema.ponderReorgEvent).values({
      domain: domainId,
      reorgedBlockHeight,
      reorgedBlockHash: hexToBuffer(reorgedBlockHash),
      newBlockHash: hexToBuffer(newBlockHash),
      affectedMsgIds: affectedMsgIds.map((id) => hexToBuffer(id)),
    });
  }

  /**
   * Get messages affected by a potential reorg at given block height.
   */
  async getMessagesAtBlock(
    chainId: number,
    blockHeight: number,
  ): Promise<`0x${string}`[]> {
    const domainId = await this.getDomainId(chainId);
    if (!domainId) return [];

    // Find block
    const blocks = await this.db
      .select({ id: schema.ponderBlock.id })
      .from(schema.ponderBlock)
      .where(
        and(
          eq(schema.ponderBlock.domain, domainId),
          eq(schema.ponderBlock.height, blockHeight),
        ),
      );

    if (blocks.length === 0) return [];

    // Find transactions in block
    const txs = await this.db
      .select({ id: schema.ponderTransaction.id })
      .from(schema.ponderTransaction)
      .where(eq(schema.ponderTransaction.blockId, blocks[0].id));

    if (txs.length === 0) return [];

    // Find messages in those transactions
    const messages = await this.db
      .select({ msgId: schema.ponderMessage.msgId })
      .from(schema.ponderMessage)
      .where(eq(schema.ponderMessage.originTxId, txs.map((t) => t.id)[0]));

    return messages.map((m) => bufferToHex(m.msgId as Buffer));
  }

  /**
   * Delete block and cascade to transactions, messages, etc.
   * Used during reorg handling.
   */
  async deleteBlockByHash(blockHash: `0x${string}`): Promise<void> {
    // Find block
    const blocks = await this.db
      .select({ id: schema.ponderBlock.id })
      .from(schema.ponderBlock)
      .where(eq(schema.ponderBlock.hash, hexToBuffer(blockHash)));

    if (blocks.length === 0) return;

    const blockId = blocks[0].id;

    // Find transactions
    const txs = await this.db
      .select({ id: schema.ponderTransaction.id })
      .from(schema.ponderTransaction)
      .where(eq(schema.ponderTransaction.blockId, blockId));

    const txIds = txs.map((t) => t.id);

    // Delete in order (reverse of FK dependencies)
    for (const txId of txIds) {
      await this.db
        .delete(schema.ponderTransactionLog)
        .where(eq(schema.ponderTransactionLog.txId, txId));
      await this.db
        .delete(schema.ponderGasPayment)
        .where(eq(schema.ponderGasPayment.txId, txId));
      await this.db
        .delete(schema.ponderDeliveredMessage)
        .where(eq(schema.ponderDeliveredMessage.destinationTxId, txId));
      await this.db
        .delete(schema.ponderMessage)
        .where(eq(schema.ponderMessage.originTxId, txId));
      await this.db
        .delete(schema.ponderMerkleTreeInsertion)
        .where(eq(schema.ponderMerkleTreeInsertion.txId, txId));
    }

    // Delete transactions
    await this.db
      .delete(schema.ponderTransaction)
      .where(eq(schema.ponderTransaction.blockId, blockId));

    // Delete block
    await this.db
      .delete(schema.ponderBlock)
      .where(eq(schema.ponderBlock.id, blockId));
  }
}

// =============================================================================
// Utility functions
// =============================================================================

function hexToBuffer(hex: `0x${string}`): Buffer {
  return Buffer.from(hex.slice(2), 'hex');
}

function bufferToHex(buf: Buffer): `0x${string}` {
  return `0x${buf.toString('hex')}` as `0x${string}`;
}

// Singleton adapter instance
let adapterInstance: PonderDbAdapter | undefined;

export function getAdapter(): PonderDbAdapter {
  if (!adapterInstance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable required');
    }
    adapterInstance = new PonderDbAdapter(connectionString);
  }
  return adapterInstance;
}
