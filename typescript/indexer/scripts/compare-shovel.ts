#!/usr/bin/env tsx
/**
 * Compare shovel_* tables against original scraper tables.
 *
 * Validates that Shovel indexer captures all events that Scraper captured
 * within the block range that Shovel has indexed.
 *
 * Usage:
 *   pnpm shovel:compare --chain basesepolia
 *   pnpm shovel:compare --chain basesepolia --content --verbose
 *   DATABASE_URL=... pnpm shovel:compare --chain basesepolia --database-url postgres://...
 */
import { Pool } from 'pg';

interface ParsedArgs {
  chain: string;
  verbose: boolean;
  content: boolean;
  databaseUrl: string | undefined;
}

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
      'Usage: pnpm shovel:compare --chain <chain_name> [--database-url <url>] [--verbose] [--content]',
    );
    console.error('Example: pnpm shovel:compare --chain basesepolia');
    console.error('Example: pnpm shovel:compare --chain basesepolia --content');
    console.error(
      'Example: pnpm shovel:compare --chain basesepolia --database-url postgres://user:pass@host:5432/db',
    );
    process.exit(1);
  }

  return { chain, verbose, content, databaseUrl };
}

interface ComparisonResult {
  table: string;
  shovelCount: number;
  scraperCount: number;
  difference: number;
  missingInShovel: number;
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
  shovelValue: string;
  scraperValue: string;
}

interface BlockRange {
  minBlock: number;
  maxBlock: number;
  blockCount: number;
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.equals(b);
}

async function getDomainId(pool: Pool, chain: string): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM domain WHERE name = $1 OR name = $2`,
    [chain, chain.toLowerCase()],
  );
  return result.rows[0]?.id ?? null;
}

async function getShovelBlockRange(
  pool: Pool,
  domainId: number,
): Promise<BlockRange | null> {
  const result = await pool.query(
    `
    SELECT
      MIN(height) as min_block,
      MAX(height) as max_block,
      COUNT(*) as block_count
    FROM shovel_block
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
    const shovelResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM shovel_message sm
      JOIN shovel_transaction st ON sm.origin_tx_id = st.id
      JOIN shovel_block sb ON st.block_id = sb.id
      WHERE sm.origin = $1
        AND sb.height >= $2 AND sb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const shovelCount = parseInt(shovelResult.rows[0].count);

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

    const missingResult = await pool.query(
      `
      SELECT m.msg_id, b.height as block_height
      FROM message m
      JOIN transaction t ON m.origin_tx_id = t.id
      JOIN block b ON t.block_id = b.id
      WHERE m.origin = $1
        AND b.height >= $2 AND b.height <= $3
        AND m.msg_id NOT IN (
          SELECT sm.msg_id FROM shovel_message sm WHERE sm.origin = $1
        )
      ORDER BY b.height
      LIMIT 10
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const missingCount = scraperCount - shovelCount;

    if (verbose && missingResult.rows.length > 0) {
      console.log(`  Missing message IDs (first 10):`);
      for (const row of missingResult.rows) {
        console.log(
          `    - ${row.msg_id.toString('hex')} (block ${row.block_height})`,
        );
      }
    }

    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          sm.msg_id,
          sm.nonce as sh_nonce, m.nonce as s_nonce,
          sm.destination as sh_destination, m.destination as s_destination,
          sm.sender as sh_sender, m.sender as s_sender,
          sm.recipient as sh_recipient, m.recipient as s_recipient,
          sm.msg_body as sh_body, m.msg_body as s_body,
          sm.origin_mailbox as sh_mailbox, m.origin_mailbox as s_mailbox
        FROM shovel_message sm
        JOIN shovel_transaction st ON sm.origin_tx_id = st.id
        JOIN shovel_block sb ON st.block_id = sb.id
        JOIN message m ON sm.msg_id = m.msg_id
        WHERE sm.origin = $1
          AND sb.height >= $2 AND sb.height <= $3
          AND (
            sm.nonce != m.nonce OR
            sm.destination != m.destination OR
            sm.sender != m.sender OR
            sm.recipient != m.recipient OR
            sm.msg_body IS DISTINCT FROM m.msg_body OR
            sm.origin_mailbox != m.origin_mailbox
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const msgId = row.msg_id.toString('hex');
        if (row.sh_nonce !== row.s_nonce) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'nonce',
            shovelValue: String(row.sh_nonce),
            scraperValue: String(row.s_nonce),
          });
        }
        if (row.sh_destination !== row.s_destination) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'destination',
            shovelValue: String(row.sh_destination),
            scraperValue: String(row.s_destination),
          });
        }
        if (!buffersEqual(row.sh_sender, row.s_sender)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'sender',
            shovelValue: row.sh_sender?.toString('hex'),
            scraperValue: row.s_sender?.toString('hex'),
          });
        }
        if (!buffersEqual(row.sh_recipient, row.s_recipient)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'recipient',
            shovelValue: row.sh_recipient?.toString('hex'),
            scraperValue: row.s_recipient?.toString('hex'),
          });
        }
        if (!buffersEqual(row.sh_body, row.s_body)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'msg_body',
            shovelValue: row.sh_body?.toString('hex')?.slice(0, 40) + '...',
            scraperValue: row.s_body?.toString('hex')?.slice(0, 40) + '...',
          });
        }
        if (!buffersEqual(row.sh_mailbox, row.s_mailbox)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'origin_mailbox',
            shovelValue: row.sh_mailbox?.toString('hex'),
            scraperValue: row.s_mailbox?.toString('hex'),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 20):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - ${m.identifier}: ${m.field} differs`);
          console.log(`        Shovel:  ${m.shovelValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (shovelCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      shovelCount,
      scraperCount,
      difference: shovelCount - scraperCount,
      missingInShovel: Math.max(0, missingCount),
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
      shovelCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInShovel: 0,
      contentMismatches: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
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
    const shovelResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM shovel_delivered_message sdm
      JOIN shovel_transaction st ON sdm.destination_tx_id = st.id
      JOIN shovel_block sb ON st.block_id = sb.id
      WHERE sdm.domain = $1
        AND sb.height >= $2 AND sb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const shovelCount = parseInt(shovelResult.rows[0].count);

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

    const missingCount = scraperCount - shovelCount;

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
            SELECT sdm.msg_id FROM shovel_delivered_message sdm WHERE sdm.domain = $1
          )
        LIMIT 10
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );
      if (missingResult.rows.length > 0) {
        console.log(`  Missing delivered message IDs (first 10):`);
        missingResult.rows.forEach((r) =>
          console.log(`    - ${r.msg_id.toString('hex')}`),
        );
      }
    }

    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          sdm.msg_id,
          sdm.destination_mailbox as sh_mailbox, dm.destination_mailbox as s_mailbox
        FROM shovel_delivered_message sdm
        JOIN shovel_transaction st ON sdm.destination_tx_id = st.id
        JOIN shovel_block sb ON st.block_id = sb.id
        JOIN delivered_message dm ON sdm.msg_id = dm.msg_id
        WHERE sdm.domain = $1
          AND sb.height >= $2 AND sb.height <= $3
          AND sdm.destination_mailbox != dm.destination_mailbox
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const msgId = row.msg_id.toString('hex');
        if (!buffersEqual(row.sh_mailbox, row.s_mailbox)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'destination_mailbox',
            shovelValue: row.sh_mailbox?.toString('hex'),
            scraperValue: row.s_mailbox?.toString('hex'),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - ${m.identifier}: ${m.field} differs`);
          console.log(`        Shovel:  ${m.shovelValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (shovelCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      shovelCount,
      scraperCount,
      difference: shovelCount - scraperCount,
      missingInShovel: Math.max(0, missingCount),
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
      shovelCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInShovel: 0,
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
    const shovelResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM shovel_gas_payment sgp
      JOIN shovel_transaction st ON sgp.tx_id = st.id
      JOIN shovel_block sb ON st.block_id = sb.id
      WHERE sgp.domain = $1
        AND sb.height >= $2 AND sb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const shovelCount = parseInt(shovelResult.rows[0].count);

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

    const missingCount = scraperCount - shovelCount;

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
            SELECT sgp.msg_id FROM shovel_gas_payment sgp WHERE sgp.domain = $1
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

    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          sgp.msg_id,
          sgp.log_index as sh_log_index,
          sgp.payment as sh_payment, gp.payment as s_payment,
          sgp.gas_amount as sh_gas, gp.gas_amount as s_gas,
          sgp.interchain_gas_paymaster as sh_igp, gp.interchain_gas_paymaster as s_igp
        FROM shovel_gas_payment sgp
        JOIN shovel_transaction st ON sgp.tx_id = st.id
        JOIN shovel_block sb ON st.block_id = sb.id
        JOIN gas_payment gp ON sgp.msg_id = gp.msg_id AND sgp.log_index = gp.log_index
        JOIN transaction t ON gp.tx_id = t.id
        JOIN block b ON t.block_id = b.id
        WHERE sgp.domain = $1
          AND sb.height >= $2 AND sb.height <= $3
          AND sb.height = b.height
          AND (
            sgp.payment != gp.payment OR
            sgp.gas_amount != gp.gas_amount OR
            sgp.interchain_gas_paymaster != gp.interchain_gas_paymaster
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const msgId = `${row.msg_id.toString('hex')}:${row.sh_log_index}`;
        if (row.sh_payment !== row.s_payment) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'payment',
            shovelValue: String(row.sh_payment),
            scraperValue: String(row.s_payment),
          });
        }
        if (row.sh_gas !== row.s_gas) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'gas_amount',
            shovelValue: String(row.sh_gas),
            scraperValue: String(row.s_gas),
          });
        }
        if (!buffersEqual(row.sh_igp, row.s_igp)) {
          mismatchDetails.push({
            identifier: msgId,
            field: 'interchain_gas_paymaster',
            shovelValue: row.sh_igp?.toString('hex'),
            scraperValue: row.s_igp?.toString('hex'),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - ${m.identifier}: ${m.field} differs`);
          console.log(`        Shovel:  ${m.shovelValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (shovelCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      shovelCount,
      scraperCount,
      difference: shovelCount - scraperCount,
      missingInShovel: Math.max(0, missingCount),
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
      shovelCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInShovel: 0,
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
    const shovelCount = blockRange.blockCount;

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

    const missingCount = scraperCount - shovelCount;

    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          sb.height,
          sb.hash as sh_hash, b.hash as s_hash,
          sb.timestamp as sh_timestamp, b.timestamp as s_timestamp
        FROM shovel_block sb
        JOIN block b ON sb.height = b.height AND sb.domain = b.domain
        WHERE sb.domain = $1
          AND sb.height >= $2 AND sb.height <= $3
          AND (
            sb.hash != b.hash OR
            sb.timestamp != b.timestamp
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const height = String(row.height);
        if (!buffersEqual(row.sh_hash, row.s_hash)) {
          mismatchDetails.push({
            identifier: height,
            field: 'hash',
            shovelValue: row.sh_hash?.toString('hex'),
            scraperValue: row.s_hash?.toString('hex'),
          });
        }
        if (row.sh_timestamp?.getTime() !== row.s_timestamp?.getTime()) {
          mismatchDetails.push({
            identifier: height,
            field: 'timestamp',
            shovelValue: row.sh_timestamp?.toISOString(),
            scraperValue: row.s_timestamp?.toISOString(),
          });
        }
      }

      if (verbose && mismatchDetails.length > 0) {
        console.log(`  Content mismatches (first 10):`);
        for (const m of mismatchDetails.slice(0, 10)) {
          console.log(`    - block ${m.identifier}: ${m.field} differs`);
          console.log(`        Shovel:  ${m.shovelValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (shovelCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      shovelCount,
      scraperCount,
      difference: shovelCount - scraperCount,
      missingInShovel: Math.max(0, missingCount),
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
      shovelCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInShovel: 0,
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
    const shovelResult = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM shovel_transaction st
      JOIN shovel_block sb ON st.block_id = sb.id
      WHERE sb.domain = $1
        AND sb.height >= $2 AND sb.height <= $3
      `,
      [domainId, blockRange.minBlock, blockRange.maxBlock],
    );
    const shovelCount = parseInt(shovelResult.rows[0].count);

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

    const missingCount = scraperCount - shovelCount;

    let contentMismatches = 0;
    const mismatchDetails: ContentMismatch[] = [];

    if (content) {
      const contentResult = await pool.query(
        `
        SELECT
          st.hash,
          st.sender as sh_sender, t.sender as s_sender,
          st.recipient as sh_recipient, t.recipient as s_recipient,
          st.nonce as sh_nonce, t.nonce as s_nonce,
          st.gas_limit as sh_gas_limit, t.gas_limit as s_gas_limit,
          st.gas_used as sh_gas_used, t.gas_used as s_gas_used,
          st.gas_price as sh_gas_price, t.gas_price as s_gas_price,
          st.effective_gas_price as sh_eff_gas, t.effective_gas_price as s_eff_gas
        FROM shovel_transaction st
        JOIN shovel_block sb ON st.block_id = sb.id
        JOIN transaction t ON st.hash = t.hash
        WHERE sb.domain = $1
          AND sb.height >= $2 AND sb.height <= $3
          AND (
            st.sender != t.sender OR
            st.recipient IS DISTINCT FROM t.recipient OR
            st.nonce != t.nonce OR
            st.gas_limit != t.gas_limit OR
            st.gas_used != t.gas_used OR
            st.gas_price IS DISTINCT FROM t.gas_price OR
            st.effective_gas_price IS DISTINCT FROM t.effective_gas_price
          )
        LIMIT 20
        `,
        [domainId, blockRange.minBlock, blockRange.maxBlock],
      );

      contentMismatches = contentResult.rows.length;
      for (const row of contentResult.rows) {
        const txHash = row.hash.toString('hex');
        if (!buffersEqual(row.sh_sender, row.s_sender)) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'sender',
            shovelValue: row.sh_sender?.toString('hex'),
            scraperValue: row.s_sender?.toString('hex'),
          });
        }
        if (!buffersEqual(row.sh_recipient, row.s_recipient)) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'recipient',
            shovelValue: row.sh_recipient?.toString('hex'),
            scraperValue: row.s_recipient?.toString('hex'),
          });
        }
        if (row.sh_nonce !== row.s_nonce) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'nonce',
            shovelValue: String(row.sh_nonce),
            scraperValue: String(row.s_nonce),
          });
        }
        if (row.sh_gas_limit !== row.s_gas_limit) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'gas_limit',
            shovelValue: String(row.sh_gas_limit),
            scraperValue: String(row.s_gas_limit),
          });
        }
        if (row.sh_gas_used !== row.s_gas_used) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'gas_used',
            shovelValue: String(row.sh_gas_used),
            scraperValue: String(row.s_gas_used),
          });
        }
        if (row.sh_gas_price !== row.s_gas_price) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'gas_price',
            shovelValue: String(row.sh_gas_price),
            scraperValue: String(row.s_gas_price),
          });
        }
        if (row.sh_eff_gas !== row.s_eff_gas) {
          mismatchDetails.push({
            identifier: txHash,
            field: 'effective_gas_price',
            shovelValue: String(row.sh_eff_gas),
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
          console.log(`        Shovel:  ${m.shovelValue}`);
          console.log(`        Scraper: ${m.scraperValue}`);
        }
      }
    }

    let status: ComparisonResult['status'] = 'OK';
    if (missingCount > 0) {
      status = 'MISSING_EVENTS';
    } else if (contentMismatches > 0) {
      status = 'CONTENT_MISMATCH';
    } else if (shovelCount > scraperCount) {
      status = 'EXTRA_EVENTS';
    }

    return {
      table,
      shovelCount,
      scraperCount,
      difference: shovelCount - scraperCount,
      missingInShovel: Math.max(0, missingCount),
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
      shovelCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInShovel: 0,
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

  if (contentMode) {
    console.log(
      `${'Table'.padEnd(25)} ${'Shovel'.padStart(10)} ${'Scraper'.padStart(10)} ${'Missing'.padStart(10)} ${'Mismatch'.padStart(10)} ${'Status'.padStart(18)}`,
    );
    console.log('-'.repeat(85));
  } else {
    console.log(
      `${'Table'.padEnd(25)} ${'Shovel'.padStart(10)} ${'Scraper'.padStart(10)} ${'Missing'.padStart(10)} ${'Status'.padStart(18)}`,
    );
    console.log('-'.repeat(75));
  }

  for (const result of results) {
    const statusIcon =
      result.status === 'OK'
        ? 'OK'
        : result.status === 'MISSING_EVENTS'
          ? 'MISSING'
          : result.status === 'EXTRA_EVENTS'
            ? 'EXTRA'
            : result.status === 'CONTENT_MISMATCH'
              ? 'MISMATCH'
              : 'ERROR';

    if (contentMode) {
      console.log(
        `${result.table.padEnd(25)} ${result.shovelCount.toString().padStart(10)} ${result.scraperCount.toString().padStart(10)} ${result.missingInShovel.toString().padStart(10)} ${result.contentMismatches.toString().padStart(10)} ${statusIcon.padStart(18)}`,
      );
    } else {
      console.log(
        `${result.table.padEnd(25)} ${result.shovelCount.toString().padStart(10)} ${result.scraperCount.toString().padStart(10)} ${result.missingInShovel.toString().padStart(10)} ${statusIcon.padStart(18)}`,
      );
    }

    if (result.details) {
      console.log(`  > ${result.details}`);
    }
  }

  console.log('-'.repeat(contentMode ? 85 : 75));

  const hasErrors = results.some((r) => r.status === 'ERROR');
  const hasMissing = results.some((r) => r.status === 'MISSING_EVENTS');
  const hasExtra = results.some((r) => r.status === 'EXTRA_EVENTS');
  const hasMismatch = results.some((r) => r.status === 'CONTENT_MISMATCH');

  const totalMissing = results.reduce((sum, r) => sum + r.missingInShovel, 0);
  const totalMismatches = results.reduce(
    (sum, r) => sum + r.contentMismatches,
    0,
  );

  console.log('\nOverall Status:');
  if (hasErrors) {
    console.log('  ERROR - Some comparisons failed with errors');
  } else if (hasMissing) {
    console.log(
      `  FAIL - Shovel MISSED ${totalMissing} events that Scraper captured`,
    );
    console.log('\n  Missed events by table:');
    for (const result of results) {
      if (result.missingInShovel > 0) {
        console.log(`    - ${result.table}: ${result.missingInShovel} events`);
      }
    }
  } else if (hasMismatch) {
    console.log(
      `  FAIL - ${totalMismatches} content mismatches found between Shovel and Scraper`,
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
      '  WARN - Shovel has extra events (may be expected if scraper lagged)',
    );
  } else {
    console.log(
      '  PASS - All events captured correctly' +
        (contentMode ? ' with matching content' : ''),
    );
  }
  console.log('');
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
    console.log(`  Database Comparison: Shovel vs Scraper`);
    console.log(`  Chain: ${chain}`);
    console.log(
      `  Mode: ${content ? 'Content comparison' : 'Count comparison'}`,
    );
    console.log(`${'='.repeat(60)}\n`);

    const domainId = await getDomainId(pool, chain);
    if (!domainId) {
      console.error(`Chain "${chain}" not found in domain table`);
      process.exit(1);
    }
    console.log(`Domain ID: ${domainId}\n`);

    const blockRange = await getShovelBlockRange(pool, domainId);
    if (!blockRange) {
      console.error('No blocks indexed by Shovel yet');
      process.exit(1);
    }
    console.log(
      `Shovel Block Range: ${blockRange.minBlock} - ${blockRange.maxBlock}`,
    );
    console.log(`Total Blocks Indexed: ${blockRange.blockCount}\n`);

    const results: ComparisonResult[] = [];

    results.push(
      await compareMessages(pool, domainId, blockRange, verbose, content),
    );

    results.push(
      await compareDeliveredMessages(
        pool,
        domainId,
        blockRange,
        verbose,
        content,
      ),
    );

    results.push(
      await compareGasPayments(pool, domainId, blockRange, verbose, content),
    );

    results.push(
      await compareBlocks(pool, domainId, blockRange, verbose, content),
    );

    results.push(
      await compareTransactions(pool, domainId, blockRange, verbose, content),
    );

    printSummary(results, content);

    const hasMissing = results.some((r) => r.status === 'MISSING_EVENTS');
    const hasMismatch = results.some((r) => r.status === 'CONTENT_MISMATCH');
    if (hasMissing || hasMismatch) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
