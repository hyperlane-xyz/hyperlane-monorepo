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
  databaseUrl: string | undefined;
}

// Parse command line arguments
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let chain = '';
  let verbose = false;
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
    }
  }

  if (!chain) {
    console.error(
      'Usage: pnpm db:comparison --chain <chain_name> [--database-url <url>] [--verbose]',
    );
    console.error('Example: pnpm db:comparison --chain sepolia');
    console.error(
      'Example: pnpm db:comparison --chain sepolia --database-url postgres://user:pass@host:5432/db',
    );
    process.exit(1);
  }

  return { chain, verbose, databaseUrl };
}

interface ComparisonResult {
  table: string;
  ponderCount: number;
  scraperCount: number;
  difference: number;
  missingInPonder: number;
  status: 'OK' | 'MISSING_EVENTS' | 'EXTRA_EVENTS' | 'ERROR';
  details?: string;
}

interface BlockRange {
  minBlock: number;
  maxBlock: number;
  blockCount: number;
}

async function main(): Promise<void> {
  const { chain, verbose, databaseUrl } = parseArgs();

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
    results.push(await compareMessages(pool, domainId, blockRange, verbose));

    // 2. Compare delivered messages
    results.push(
      await compareDeliveredMessages(pool, domainId, blockRange, verbose),
    );

    // 3. Compare gas payments
    results.push(await compareGasPayments(pool, domainId, blockRange, verbose));

    // 4. Compare blocks
    results.push(await compareBlocks(pool, domainId, blockRange, verbose));

    // 5. Compare transactions
    results.push(
      await compareTransactions(pool, domainId, blockRange, verbose),
    );

    // Print summary
    printSummary(results);

    // Exit with error if any missing events
    const hasMissing = results.some((r) => r.status === 'MISSING_EVENTS');
    if (hasMissing) {
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

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      status:
        missingCount > 0
          ? 'MISSING_EVENTS'
          : ponderCount > scraperCount
            ? 'EXTRA_EVENTS'
            : 'OK',
      details:
        missingResult.rows.length > 0
          ? `${missingResult.rows.length} missing IDs found`
          : undefined,
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
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

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      status:
        missingCount > 0
          ? 'MISSING_EVENTS'
          : ponderCount > scraperCount
            ? 'EXTRA_EVENTS'
            : 'OK',
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
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

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      status:
        missingCount > 0
          ? 'MISSING_EVENTS'
          : ponderCount > scraperCount
            ? 'EXTRA_EVENTS'
            : 'OK',
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

async function compareBlocks(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  _verbose: boolean,
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

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      status:
        missingCount > 0
          ? 'MISSING_EVENTS'
          : ponderCount > scraperCount
            ? 'EXTRA_EVENTS'
            : 'OK',
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

async function compareTransactions(
  pool: Pool,
  domainId: number,
  blockRange: BlockRange,
  _verbose: boolean,
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

    return {
      table,
      ponderCount,
      scraperCount,
      difference: ponderCount - scraperCount,
      missingInPonder: Math.max(0, missingCount),
      status:
        missingCount > 0
          ? 'MISSING_EVENTS'
          : ponderCount > scraperCount
            ? 'EXTRA_EVENTS'
            : 'OK',
    };
  } catch (error) {
    return {
      table,
      ponderCount: 0,
      scraperCount: 0,
      difference: 0,
      missingInPonder: 0,
      status: 'ERROR',
      details: (error as Error).message,
    };
  }
}

function printSummary(results: ComparisonResult[]): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  COMPARISON SUMMARY');
  console.log(`${'='.repeat(60)}\n`);

  // Table header
  console.log(
    `${'Table'.padEnd(25)} ${'Ponder'.padStart(10)} ${'Scraper'.padStart(10)} ${'Missing'.padStart(10)} ${'Status'.padStart(15)}`,
  );
  console.log('-'.repeat(70));

  for (const result of results) {
    const statusIcon =
      result.status === 'OK'
        ? '✅'
        : result.status === 'MISSING_EVENTS'
          ? '❌'
          : result.status === 'EXTRA_EVENTS'
            ? '⚠️'
            : '💥';

    console.log(
      `${result.table.padEnd(25)} ${result.ponderCount.toString().padStart(10)} ${result.scraperCount.toString().padStart(10)} ${result.missingInPonder.toString().padStart(10)} ${statusIcon} ${result.status.padStart(12)}`,
    );

    if (result.details) {
      console.log(`  └─ ${result.details}`);
    }
  }

  console.log('-'.repeat(70));

  // Overall status
  const hasErrors = results.some((r) => r.status === 'ERROR');
  const hasMissing = results.some((r) => r.status === 'MISSING_EVENTS');
  const hasExtra = results.some((r) => r.status === 'EXTRA_EVENTS');

  // Calculate totals
  const totalMissing = results.reduce((sum, r) => sum + r.missingInPonder, 0);

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
  } else if (hasExtra) {
    console.log(
      '  ⚠️  WARN - Ponder has extra events (may be expected if scraper lagged)',
    );
  } else {
    console.log('  ✅ PASS - All events captured correctly');
  }
  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
