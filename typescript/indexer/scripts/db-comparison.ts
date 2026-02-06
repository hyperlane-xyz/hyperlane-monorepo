#!/usr/bin/env tsx
/**
 * Compare ponder_* tables against original scraper tables.
 *
 * Validates that Ponder indexer captures all events that Scraper captured
 * within the block range that Ponder has indexed.
 *
 * Usage:
 *   pnpm db:comparison --chain sepolia --database-url postgres://...
 *   DATABASE_URL=... pnpm db:comparison --chain ethereum
 */
import { Pool } from 'pg';

interface ParsedArgs {
  chain: string;
  verbose: boolean;
  content: boolean;
  databaseUrl: string | undefined;
}

// Parse command line arguments
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let chain = '';
  let verbose = false;
  let content = false;
  let databaseUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chain' && args[i + 1]) {
      chain = args[i + 1];
      i++;
    } else if (args[i] === '--database-url' && args[i + 1]) {
      databaseUrl = args[i + 1];
      i++;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (args[i] === '--content' || args[i] === '-c') {
      content = true;
    }
  }

  if (!chain) {
    console.error(
      'Usage: pnpm db:comparison --chain <chain_name> [--database-url <url>] [--verbose] [--content]',
    );
    console.error('Example: pnpm db:comparison --chain sepolia');
    console.error('Example: pnpm db:comparison --chain sepolia --content');
    console.error(
      'Example: pnpm db:comparison --chain sepolia --database-url postgres://user:pass@host:5432/db',
    );
    process.exit(1);
  }

  return { chain, verbose, content, databaseUrl };
}

interface ComparisonResult {
  table: string;
  ponderCount: number;
  scraperCount: number;
  difference: number;
  missingInPonder: number;
  contentMismatches: number;
  status:
    | 'OK'
    | 'MISSING_EVENTS'
    | 'EXTRA_EVENTS'
    | 'CONTENT_MISMATCH'
    | 'ERROR';
  details?: string;
  mismatchDetails?: ContentMismatch[];
}

interface ContentMismatch {
  identifier: string;
  field: string;
  ponderValue: string;
  scraperValue: string;
}

interface BlockRange {
  minBlock: number;
  maxBlock: number;
  blockCount: number;
}

async function main(): Promise<void> {
  const { chain, verbose, content, databaseUrl } = parseArgs();

  const connectionString = databaseUrl || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'Database URL required: use --database-url or set DATABASE_URL env var',
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Database Comparison: Ponder vs Scraper`);
    console.log(`  Chain: ${chain}`);
    console.log(
      `  Mode: ${content ? 'Content comparison' : 'Count comparison'}`,
    );
    console.log(`${'='.repeat(60)}\n`);

    // Get domain ID for chain
    const domainId = await getDomainId(pool, chain);
    if (!domainId) {
      console.error(`Chain "${chain}" not found in domain table`);
      process.exit(1);
    }
    console.log(`Domain ID: ${domainId}\n`);

    // Get Ponder's indexed block range
    const blockRange = await getPonderBlockRange(pool, domainId);
    if (!blockRange) {
      console.error('No blocks indexed by Ponder yet');
      process.exit(1);
    }
    console.log(
      `Ponder Block Range: ${blockRange.minBlock} - ${blockRange.maxBlock}`,
    );
    console.log(`Total Blocks Indexed: ${blockRange.blockCount}\n`);

    // Compare each table
    const results: ComparisonResult[] = [];

    // 1. Compare messages (dispatched)
    results.push(
      await compareMessages(pool, domainId, blockRange, verbose, content),
    );

    // 2. Compare delivered messages
    results.push(
      await compareDeliveredMessages(
        pool,
        domainId,
        blockRange,
        verbose,
        content,
      ),
    );

    // 3. Compare gas payments
    results.push(
      await compareGasPayments(pool, domainId, blockRange, verbose, content),
    );

    // 4. Compare blocks
    results.push(
      await compareBlocks(pool, domainId, blockRange, verbose, content),
    );

    // 5. Compare transactions
    results.push(
      await compareTransactions(pool, domainId, blockRange, verbose, content),
    );

    // Print summary
    printSummary(results, content);

    // Exit with error if any missing events or content mismatches
    const hasMissing = results.some((r) => r.status === 'MISSING_EVENTS');
    const hasMismatch = results.some((r) => r.status === 'CONTENT_MISMATCH');
    if (hasMissing || hasMismatch) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

async function getDomainId(pool: Pool, chain: string): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM domain WHERE name = $1 OR name = $2`,
    [chain, chain.toLowerCase()],
  );
  return result.rows[0]?.id ?? null;
}

async function getPonderBlockRange(
  pool: Pool,
  domainId: number,
): Promise<BlockRange | null> {
  const result = await pool.query(
    `
    SELECT
      MIN(height) as min_block,
      MAX(height) as max_block,
      COUNT(*) as block_count
    FROM ponder_block
    WHERE domain = $1
    `,
    [domainId],
  );

  const row = result.rows[0];
  if (!row.min_block) return null;

  return {
    minBlock: parseInt(row.min_block),
    maxBlock: parseInt(row.max_block),
    blockCount: parseInt(row.block_count),
  };
}

async function compareMessages(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  verbose: boolean,
  content: boolean,
): Promise<ComparisonResult> {
  const table = 'message (origin)';

  try {
    // Count Ponder messages
    const ponderResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM ponder_message pm
      JOIN ponder_transaction pt ON pm.origin_tx_id = pt.id
      JOIN ponder_block pb ON pt.block_id = pb.id
      WHERE pm.origin = $1
        AND pb.height >= $2 AND pb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const ponderCount = parseInt(ponderResult.rows[0].count);

    // Count Scraper messages in same block range
    const scraperResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM message m
      JOIN transaction t ON m.origin_tx_id = t.id
      JOIN block b ON t.block_id = b.id
      WHERE m.origin = $1
        AND b.height >= $2 AND b.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const scraperCount = parseInt(scraperResult.rows[0].count);

    // Find missing message IDs (in scraper but not in ponder)
    const missingResult = await pool.query(
      `
      SELECT m.msg_id, b.height as block_height
      FROM message m
      JOIN transaction t ON m.origin_tx_id = t.id
      JOIN block b ON t.block_id = b.id
      WHERE m.origin = $1
        AND b.height >= $2 AND b.height <= $3
        AND m.msg_id NOT IN (
          SELECT pm.msg_id FROM ponder_message pm WHERE pm.origin = $1
        )
      ORDER BY b.height
      LIMIT 10
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const missingCount = scraperCount - ponderCount;

    if (verbose && missingResult.rows.length > 0) {
      console.log(`  Missing message IDs (first 10):`);
      for (const row of missingResult.rows) {
        console.log(
          `    - ${row.msg_id.toString('hex')} (block ${row.block_height})`,
        );
      }
    }

    // Content comparison
    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          pm.msg_id,
          pm.nonce as p_nonce, m.nonce as s_nonce,
          pm.destination as p_destination, m.destination as s_destination,
          pm.sender as p_sender, m.sender as s_sender,
          pm.recipient as p_recipient, m.recipient as s_recipient,
          pm.msg_body as p_body, m.msg_body as s_body,
          pm.origin_mailbox as p_mailbox, m.origin_mailbox as s_mailbox
        FROM ponder_message pm
        JOIN ponder_transaction pt ON pm.origin_tx_id = pt.id
        JOIN ponder_block pb ON pt.block_id = pb.id
        JOIN message m ON pm.msg_id = m.msg_id
        WHERE pm.origin = $1
          AND pb.height >= $2 AND pb.height <= $3
          AND (
            pm.nonce != m.nonce OR
            pm.destination != m.destination OR
            pm.sender != m.sender OR
            pm.recipient != m.recipient OR
            pm.msg_body IS DISTINCT FROM m.msg_body OR
            pm.origin_mailbox != m.origin_mailbox
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const msgId = row.msg_id.toString('hex');
        if (row.p_nonce !== row.s_nonce) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'nonce',
            ponderValue: String(row.p_nonce),
            scraperValue: String(row.s_nonce),
          });
        }
        if (row.p_destination !== row.s_destination) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'destination',
            ponderValue: String(row.p_destination),
            scraperValue: String(row.s_destination),
          });
        }
        if (!buffersEqual(row.p_sender, row.s_sender)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'sender',
            ponderValue: row.p_sender?.toString('hex'),
            scraperValue: row.s_sender?.toString('hex'),
          });
        }
        if (!buffersEqual(row.p_recipient, row.s_recipient)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'recipient',
            ponderValue: row.p_recipient?.toString('hex'),
            scraperValue: row.s_recipient?.toString('hex'),
          });
        }
        if (!buffersEqual(row.p_body, row.s_body)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'msg_body',
            ponderValue: row.p_body?.toString('hex')?.slice(0, 40) + '...',
            scraperValue: row.s_body?.toString('hex')?.slice(0, 40) + '...',
          });
        }
        if (!buffersEqual(row.p_mailbox, row.s_mailbox)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'origin_mailbox',
            ponderValue: row.p_mailbox?.toString('hex'),
            scraperValue: row.s_mailbox?.toString('hex'),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 20):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - ${m.identifier}: ${m.field} differs`);
          console.log(`        Ponder:  ${m.ponderValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (ponderCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      contentMismatches,
      status,
      details:
        missingResult.rows.length > 0
          ? `${missingResult.rows.length} missing IDs found`
          : contentMismatches > 0
            ? `${contentMismatches} content mismatches`
            : undefined,
      mismatchDetails: mismatchDetails.length > 0 ? mismatchDetails : undefined,
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      contentMismatches: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

async function compareDeliveredMessages(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  verbose: boolean,
  content: boolean,
): Promise<ComparisonResult> {
  const table = 'delivered_message';

  try {
    // Count Ponder delivered messages
    const ponderResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM ponder_delivered_message pdm
      JOIN ponder_transaction pt ON pdm.destination_tx_id = pt.id
      JOIN ponder_block pb ON pt.block_id = pb.id
      WHERE pdm.domain = $1
        AND pb.height >= $2 AND pb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const ponderCount = parseInt(ponderResult.rows[0].count);

    // Count Scraper delivered messages
    const scraperResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM delivered_message dm
      JOIN transaction t ON dm.destination_tx_id = t.id
      JOIN block b ON t.block_id = b.id
      WHERE dm.domain = $1
        AND b.height >= $2 AND b.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const scraperCount = parseInt(scraperResult.rows[0].count);

    const missingCount = scraperCount - ponderCount;

    // Find missing
    let missingIds: string[] = [];
    if (verbose && missingCount > 0) {
      const missingResult = await pool.query(
        `
        SELECT dm.msg_id
        FROM delivered_message dm
        JOIN transaction t ON dm.destination_tx_id = t.id
        JOIN block b ON t.block_id = b.id
        WHERE dm.domain = $1
          AND b.height >= $2 AND b.height <= $3
          AND dm.msg_id NOT IN (
            SELECT pdm.msg_id FROM ponder_delivered_message pdm WHERE pdm.domain = $1
          )
        LIMIT 10
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );
      missingIds = missingResult.rows.map((r) => r.msg_id.toString('hex'));
      if (missingIds.length > 0) {
        console.log(`  Missing delivered message IDs (first 10):`);
        missingIds.forEach((id) => console.log(`    - ${id}`));
      }
    }

    // Content comparison
    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          pdm.msg_id,
          pdm.destination_mailbox as p_mailbox, dm.destination_mailbox as s_mailbox,
          pdm.log_index as p_log_index, dm.log_index as s_log_index
        FROM ponder_delivered_message pdm
        JOIN ponder_transaction pt ON pdm.destination_tx_id = pt.id
        JOIN ponder_block pb ON pt.block_id = pb.id
        JOIN delivered_message dm ON pdm.msg_id = dm.msg_id
        WHERE pdm.domain = $1
          AND pb.height >= $2 AND pb.height <= $3
          AND (
            pdm.destination_mailbox != dm.destination_mailbox OR
            pdm.log_index != dm.log_index
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const msgId = row.msg_id.toString('hex');
        if (!buffersEqual(row.p_mailbox, row.s_mailbox)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'destination_mailbox',
            ponderValue: row.p_mailbox?.toString('hex'),
            scraperValue: row.s_mailbox?.toString('hex'),
          });
        }
        if (row.p_log_index !== row.s_log_index) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'log_index',
            ponderValue: String(row.p_log_index),
            scraperValue: String(row.s_log_index),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - ${m.identifier}: ${m.field} differs`);
          console.log(`        Ponder:  ${m.ponderValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (ponderCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      contentMismatches,
      status,
      details:
        contentMismatches > 0
          ? `${contentMismatches} content mismatches`
          : undefined,
      mismatchDetails: mismatchDetails.length > 0 ? mismatchDetails : undefined,
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      contentMismatches: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

async function compareGasPayments(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  verbose: boolean,
  content: boolean,
): Promise<ComparisonResult> {
  const table = 'gas_payment';

  try {
    // Count Ponder gas payments
    const ponderResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM ponder_gas_payment pgp
      JOIN ponder_transaction pt ON pgp.tx_id = pt.id
      JOIN ponder_block pb ON pt.block_id = pb.id
      WHERE pgp.domain = $1
        AND pb.height >= $2 AND pb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const ponderCount = parseInt(ponderResult.rows[0].count);

    // Count Scraper gas payments
    const scraperResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM gas_payment gp
      JOIN transaction t ON gp.tx_id = t.id
      JOIN block b ON t.block_id = b.id
      WHERE gp.domain = $1
        AND b.height >= $2 AND b.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const scraperCount = parseInt(scraperResult.rows[0].count);

    const missingCount = scraperCount - ponderCount;

    // Find missing gas payment IDs
    if (verbose && missingCount > 0) {
      const missingResult = await pool.query(
        `
        SELECT gp.msg_id, b.height as block_height
        FROM gas_payment gp
        JOIN transaction t ON gp.tx_id = t.id
        JOIN block b ON t.block_id = b.id
        WHERE gp.domain = $1
          AND b.height >= $2 AND b.height <= $3
          AND gp.msg_id NOT IN (
            SELECT pgp.msg_id FROM ponder_gas_payment pgp WHERE pgp.domain = $1
          )
        ORDER BY b.height
        LIMIT 10
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );
      if (missingResult.rows.length > 0) {
        console.log(`  Missing gas payment msg_ids (first 10):`);
        for (const row of missingResult.rows) {
          console.log(
            `    - ${row.msg_id.toString('hex')} (block ${row.block_height})`,
          );
        }
      }
    }

    // Content comparison
    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          pgp.msg_id,
          pgp.log_index as p_log_index,
          pgp.payment as p_payment, gp.payment as s_payment,
          pgp.gas_amount as p_gas, gp.gas_amount as s_gas,
          pgp.interchain_gas_paymaster as p_igp, gp.interchain_gas_paymaster as s_igp
        FROM ponder_gas_payment pgp
        JOIN ponder_transaction pt ON pgp.tx_id = pt.id
        JOIN ponder_block pb ON pt.block_id = pb.id
        JOIN gas_payment gp ON pgp.msg_id = gp.msg_id AND pgp.log_index = gp.log_index
        JOIN transaction t ON gp.tx_id = t.id
        JOIN block b ON t.block_id = b.id
        WHERE pgp.domain = $1
          AND pb.height >= $2 AND pb.height <= $3
          AND pb.height = b.height
          AND (
            pgp.payment != gp.payment OR
            pgp.gas_amount != gp.gas_amount OR
            pgp.interchain_gas_paymaster != gp.interchain_gas_paymaster
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const msgId = `${row.msg_id.toString('hex')}:${row.p_log_index}`;
        if (row.p_payment !== row.s_payment) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'payment',
            ponderValue: String(row.p_payment),
            scraperValue: String(row.s_payment),
          });
        }
        if (row.p_gas !== row.s_gas) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'gas_amount',
            ponderValue: String(row.p_gas),
            scraperValue: String(row.s_gas),
          });
        }
        if (!buffersEqual(row.p_igp, row.s_igp)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'interchain_gas_paymaster',
            ponderValue: row.p_igp?.toString('hex'),
            scraperValue: row.s_igp?.toString('hex'),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - ${m.identifier}: ${m.field} differs`);
          console.log(`        Ponder:  ${m.ponderValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (ponderCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      contentMismatches,
      status,
      details:
        contentMismatches > 0
          ? `${contentMismatches} content mismatches`
          : undefined,
      mismatchDetails: mismatchDetails.length > 0 ? mismatchDetails : undefined,
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      contentMismatches: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

async function compareBlocks(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  verbose: boolean,
  content: boolean,
): Promise<ComparisonResult> {
  const table = 'block';

  try {
    // Ponder block count is already known
    const ponderCount = blockRange.blockCount;

    // Count Scraper blocks in same range
    const scraperResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM block
      WHERE domain = $1
        AND height >= $2 AND height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const scraperCount = parseInt(scraperResult.rows[0].count);

    const missingCount = scraperCount - ponderCount;

    // Content comparison
    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          pb.height,
          pb.hash as p_hash, b.hash as s_hash,
          pb.timestamp as p_timestamp, b.timestamp as s_timestamp
        FROM ponder_block pb
        JOIN block b ON pb.height = b.height AND pb.domain = b.domain
        WHERE pb.domain = $1
          AND pb.height >= $2 AND pb.height <= $3
          AND (
            pb.hash != b.hash OR
            pb.timestamp != b.timestamp
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const height = String(row.height);
        if (!buffersEqual(row.p_hash, row.s_hash)) {
          mismatchDetails.push({
            identifier: height,
            field: 'hash',
            ponderValue: row.p_hash?.toString('hex'),
            scraperValue: row.s_hash?.toString('hex'),
          });
        }
        if (row.p_timestamp?.getTime() !== row.s_timestamp?.getTime()) {
          mismatchDetails.push({
            identifier: height,
            field: 'timestamp',
            ponderValue: row.p_timestamp?.toISOString(),
            scraperValue: row.s_timestamp?.toISOString(),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - block ${m.identifier}: ${m.field} differs`);
          console.log(`        Ponder:  ${m.ponderValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (ponderCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      contentMismatches,
      status,
      details:
        contentMismatches > 0
          ? `${contentMismatches} content mismatches`
          : undefined,
      mismatchDetails: mismatchDetails.length > 0 ? mismatchDetails : undefined,
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      contentMismatches: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

async function compareTransactions(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  verbose: boolean,
  content: boolean,
): Promise<ComparisonResult> {
  const table = 'transaction';

  try {
    // Count Ponder transactions
    const ponderResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM ponder_transaction pt
      JOIN ponder_block pb ON pt.block_id = pb.id
      WHERE pb.domain = $1
        AND pb.height >= $2 AND pb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const ponderCount = parseInt(ponderResult.rows[0].count);

    // Count Scraper transactions
    const scraperResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM transaction t
      JOIN block b ON t.block_id = b.id
      WHERE b.domain = $1
        AND b.height >= $2 AND b.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const scraperCount = parseInt(scraperResult.rows[0].count);

    const missingCount = scraperCount - ponderCount;

    // Content comparison
    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          pt.hash,
          pt.sender as p_sender, t.sender as s_sender,
          pt.recipient as p_recipient, t.recipient as s_recipient,
          pt.nonce as p_nonce, t.nonce as s_nonce,
          pt.gas_limit as p_gas_limit, t.gas_limit as s_gas_limit,
          pt.gas_used as p_gas_used, t.gas_used as s_gas_used,
          pt.gas_price as p_gas_price, t.gas_price as s_gas_price,
          pt.effective_gas_price as p_eff_gas, t.effective_gas_price as s_eff_gas
        FROM ponder_transaction pt
        JOIN ponder_block pb ON pt.block_id = pb.id
        JOIN transaction t ON pt.hash = t.hash
        WHERE pb.domain = $1
          AND pb.height >= $2 AND pb.height <= $3
          AND (
            pt.sender != t.sender OR
            pt.recipient IS DISTINCT FROM t.recipient OR
            pt.nonce != t.nonce OR
            pt.gas_limit != t.gas_limit OR
            pt.gas_used != t.gas_used OR
            pt.gas_price IS DISTINCT FROM t.gas_price OR
            pt.effective_gas_price IS DISTINCT FROM t.effective_gas_price
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const txHash = row.hash.toString('hex');
        if (!buffersEqual(row.p_sender, row.s_sender)) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'sender',
            ponderValue: row.p_sender?.toString('hex'),
            scraperValue: row.s_sender?.toString('hex'),
          });
        }
        if (!buffersEqual(row.p_recipient, row.s_recipient)) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'recipient',
            ponderValue: row.p_recipient?.toString('hex'),
            scraperValue: row.s_recipient?.toString('hex'),
          });
        }
        if (row.p_nonce !== row.s_nonce) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'nonce',
            ponderValue: String(row.p_nonce),
            scraperValue: String(row.s_nonce),
          });
        }
        if (row.p_gas_limit !== row.s_gas_limit) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'gas_limit',
            ponderValue: String(row.p_gas_limit),
            scraperValue: String(row.s_gas_limit),
          });
        }
        if (row.p_gas_used !== row.s_gas_used) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'gas_used',
            ponderValue: String(row.p_gas_used),
            scraperValue: String(row.s_gas_used),
          });
        }
        if (row.p_gas_price !== row.s_gas_price) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'gas_price',
            ponderValue: String(row.p_gas_price),
            scraperValue: String(row.s_gas_price),
          });
        }
        if (row.p_eff_gas !== row.s_eff_gas) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'effective_gas_price',
            ponderValue: String(row.p_eff_gas),
            scraperValue: String(row.s_eff_gas),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(
            `    - tx ${m.identifier.slice(0, 16)}...: ${m.field} differs`,
          );
          console.log(`        Ponder:  ${m.ponderValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (ponderCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      contentMismatches,
      status,
      details:
        contentMismatches > 0
          ? `${contentMismatches} content mismatches`
          : undefined,
      mismatchDetails: mismatchDetails.length > 0 ? mismatchDetails : undefined,
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      contentMismatches: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

function printSummary(results: ComparisonResult[], contentMode: boolean): void {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  COMPARISON SUMMARY');
  console.log(`${'='.repeat(80)}\n`);

  // Table header
  if (contentMode) {
    console.log(
      `${'Table'.padEnd(25)} ${'Ponder'.padStart(10)} ${'Scraper'.padStart(10)} ${'Missing'.padStart(10)} ${'Mismatch'.padStart(10)} ${'Status'.padStart(18)}`,
    );
    console.log('-'.repeat(85));
  } else {
    console.log(
      `${'Table'.padEnd(25)} ${'Ponder'.padStart(10)} ${'Scraper'.padStart(10)} ${'Missing'.padStart(10)} ${'Status'.padStart(18)}`,
    );
    console.log('-'.repeat(75));
  }

  for (const result of results) {
    const statusIcon =
      result.status === 'OK'
        ? '✅'
        : result.status === 'MISSING_EVENTS'
          ? '❌'
          : result.status === 'EXTRA_EVENTS'
            ? '⚠️'
            : result.status === 'CONTENT_MISMATCH'
              ? '🔀'
              : '💥';

    if (contentMode) {
      console.log(
        `${result.table.padEnd(25)} ${result.ponderCount.toString().padStart(10)} ${result.scraperCount.toString().padStart(10)} ${result.missingInPonder.toString().padStart(10)} ${result.contentMismatches.toString().padStart(10)} ${statusIcon} ${result.status.padStart(15)}`,
      );
    } else {
      console.log(
        `${result.table.padEnd(25)} ${result.ponderCount.toString().padStart(10)} ${result.scraperCount.toString().padStart(10)} ${result.missingInPonder.toString().padStart(10)} ${statusIcon} ${result.status.padStart(15)}`,
      );
    }

    if (result.details) {
      console.log(`  └─ ${result.details}`);
    }
  }

  console.log('-'.repeat(contentMode ? 85 : 75));

  // Overall status
  const hasErrors = results.some((r) => r.status === 'ERROR');
  const hasMissing = results.some((r) => r.status === 'MISSING_EVENTS');
  const hasExtra = results.some((r) => r.status === 'EXTRA_EVENTS');
  const hasMismatch = results.some((r) => r.status === 'CONTENT_MISMATCH');

  // Calculate totals
  const totalMissing = results.reduce((sum, r) => sum + r.missingInPonder, 0);
  const totalMismatches = results.reduce(
    (sum, r) => sum + r.contentMismatches,
    0,
  );

  console.log('\nOverall Status:');
  if (hasErrors) {
    console.log('  💥 Some comparisons failed with errors');
  } else if (hasMissing) {
    console.log(
      `  ❌ FAIL - Ponder MISSED ${totalMissing} events that Scraper captured`,
    );
    console.log('\n  Missed events by table:');
    for (const result of results) {
      if (result.missingInPonder > 0) {
        console.log(`    - ${result.table}: ${result.missingInPonder} events`);
      }
    }
  } else if (hasMismatch) {
    console.log(
      `  🔀 FAIL - ${totalMismatches} content mismatches found between Ponder and Scraper`,
    );
    console.log('\n  Mismatches by table:');
    for (const result of results) {
      if (result.contentMismatches > 0) {
        console.log(
          `    - ${result.table}: ${result.contentMismatches} mismatches`,
        );
      }
    }
  } else if (hasExtra) {
    console.log(
      '  ⚠️  WARN - Ponder has extra events (may be expected if scraper lagged)',
    );
  } else {
    console.log(
      '  ✅ PASS - All events captured correctly' +
        (contentMode ? ' with matching content' : ''),
    );
  }
  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
