#!/usr/bin/env tsx
/**
 * Compare ponder_* tables with scraper tables to validate indexing consistency.
 *
 * Usage:
 *   pnpm db:compare
 *   DATABASE_URL=... tsx scripts/compare.ts
 */
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

interface ComparisonResult {
  table: string;
  scraperCount: number;
  ponderCount: number;
  difference: number;
  matchRate: string;
}

// @ts-ignore - Reserved for future use
interface _MessageComparison {
  msgId: string;
  inScraper: boolean;
  inPonder: boolean;
  scraperOrigin?: number;
  ponderOrigin?: number;
  scraperDestination?: number;
  ponderDestination?: number;
}

async function main() {
  console.log('Comparing ponder_* tables with scraper tables...\n');

  // Compare counts
  const countResults = await compareTableCounts();
  printCountResults(countResults);

  // Compare message IDs
  console.log('\n--- Message ID Comparison (last 1000 messages) ---\n');
  const msgComparison = await compareMessageIds(1000);
  printMessageComparison(msgComparison);

  // Compare delivery status
  console.log('\n--- Delivery Status Comparison ---\n');
  await compareDeliveryStatus();

  // Compare gas payments
  console.log('\n--- Gas Payment Comparison ---\n');
  await compareGasPayments();

  await pool.end();
}

async function compareTableCounts(): Promise<ComparisonResult[]> {
  const tables = [
    { scraper: 'block', ponder: 'ponder_block' },
    { scraper: 'transaction', ponder: 'ponder_transaction' },
    { scraper: 'message', ponder: 'ponder_message' },
    { scraper: 'delivered_message', ponder: 'ponder_delivered_message' },
    { scraper: 'gas_payment', ponder: 'ponder_gas_payment' },
    { scraper: 'raw_message_dispatch', ponder: 'ponder_raw_message_dispatch' },
  ];

  const results: ComparisonResult[] = [];

  for (const { scraper, ponder } of tables) {
    try {
      const scraperResult = await pool.query(
        `SELECT COUNT(*) as count FROM ${scraper}`,
      );
      const ponderResult = await pool.query(
        `SELECT COUNT(*) as count FROM ${ponder}`,
      );

      const scraperCount = parseInt(scraperResult.rows[0].count);
      const ponderCount = parseInt(ponderResult.rows[0].count);
      const difference = Math.abs(scraperCount - ponderCount);
      const matchRate =
        scraperCount > 0
          ? (
              (Math.min(scraperCount, ponderCount) / scraperCount) *
              100
            ).toFixed(2) + '%'
          : 'N/A';

      results.push({
        table: scraper,
        scraperCount,
        ponderCount,
        difference,
        matchRate,
      });
    } catch (error: unknown) {
      const err = error as Error;
      console.warn(`Error comparing ${scraper}: ${err.message}`);
      results.push({
        table: scraper,
        scraperCount: -1,
        ponderCount: -1,
        difference: -1,
        matchRate: 'ERROR',
      });
    }
  }

  return results;
}

function printCountResults(results: ComparisonResult[]): void {
  console.log('--- Table Count Comparison ---\n');
  console.log(
    'Table'.padEnd(25) +
      'Scraper'.padStart(12) +
      'Ponder'.padStart(12) +
      'Diff'.padStart(12) +
      'Match'.padStart(10),
  );
  console.log('-'.repeat(71));

  for (const r of results) {
    console.log(
      r.table.padEnd(25) +
        r.scraperCount.toString().padStart(12) +
        r.ponderCount.toString().padStart(12) +
        r.difference.toString().padStart(12) +
        r.matchRate.padStart(10),
    );
  }
}

async function compareMessageIds(
  limit: number,
): Promise<{ matching: number; scraperOnly: number; ponderOnly: number }> {
  try {
    // Get recent message IDs from both tables
    const scraperMsgs = await pool.query(
      `
      SELECT ENCODE(msg_id, 'hex') as msg_id, origin, destination
      FROM message
      ORDER BY id DESC
      LIMIT $1
    `,
      [limit],
    );

    const ponderMsgs = await pool.query(
      `
      SELECT ENCODE(msg_id, 'hex') as msg_id, origin, destination
      FROM ponder_message
      ORDER BY id DESC
      LIMIT $1
    `,
      [limit],
    );

    const scraperSet = new Set(scraperMsgs.rows.map((r) => r.msg_id));
    const ponderSet = new Set(ponderMsgs.rows.map((r) => r.msg_id));

    let matching = 0;
    let scraperOnly = 0;
    let ponderOnly = 0;

    for (const msgId of scraperSet) {
      if (ponderSet.has(msgId)) {
        matching++;
      } else {
        scraperOnly++;
      }
    }

    for (const msgId of ponderSet) {
      if (!scraperSet.has(msgId)) {
        ponderOnly++;
      }
    }

    return { matching, scraperOnly, ponderOnly };
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error comparing message IDs: ${err.message}`);
    return { matching: 0, scraperOnly: 0, ponderOnly: 0 };
  }
}

function printMessageComparison(comparison: {
  matching: number;
  scraperOnly: number;
  ponderOnly: number;
}): void {
  console.log(`Matching messages:     ${comparison.matching}`);
  console.log(`Scraper only:          ${comparison.scraperOnly}`);
  console.log(`Ponder only:           ${comparison.ponderOnly}`);

  const total =
    comparison.matching + comparison.scraperOnly + comparison.ponderOnly;
  if (total > 0) {
    const matchRate = ((comparison.matching / total) * 100).toFixed(2);
    console.log(`\nOverall match rate:    ${matchRate}%`);
  }
}

async function compareDeliveryStatus(): Promise<void> {
  try {
    // Compare delivered message counts
    const scraperDelivered = await pool.query(
      'SELECT COUNT(*) as count FROM delivered_message',
    );
    const ponderDelivered = await pool.query(
      'SELECT COUNT(*) as count FROM ponder_delivered_message',
    );

    console.log(`Scraper delivered:     ${scraperDelivered.rows[0].count}`);
    console.log(`Ponder delivered:      ${ponderDelivered.rows[0].count}`);

    // Find messages delivered in scraper but not ponder
    const missingInPonder = await pool.query(`
      SELECT COUNT(*) as count
      FROM delivered_message dm
      WHERE NOT EXISTS (
        SELECT 1 FROM ponder_delivered_message pdm
        WHERE pdm.msg_id = dm.msg_id
      )
    `);
    console.log(`Missing in Ponder:     ${missingInPonder.rows[0].count}`);
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error comparing deliveries: ${err.message}`);
  }
}

async function compareGasPayments(): Promise<void> {
  try {
    // Compare gas payment counts
    const scraperPayments = await pool.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(payment::numeric), 0) as total FROM gas_payment',
    );
    const ponderPayments = await pool.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(payment::numeric), 0) as total FROM ponder_gas_payment',
    );

    console.log(`Scraper payments:      ${scraperPayments.rows[0].count}`);
    console.log(`Ponder payments:       ${ponderPayments.rows[0].count}`);
    console.log(
      `Scraper total:         ${BigInt(scraperPayments.rows[0].total || 0)}`,
    );
    console.log(
      `Ponder total:          ${BigInt(ponderPayments.rows[0].total || 0)}`,
    );
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error comparing gas payments: ${err.message}`);
  }
}

// Time-window comparison for more precise analysis
// @ts-ignore - Reserved for future use
async function _compareTimeWindow(
  startTime: Date,
  endTime: Date,
): Promise<void> {
  console.log(
    `\n--- Time Window Comparison: ${startTime.toISOString()} to ${endTime.toISOString()} ---\n`,
  );

  const scraperQuery = `
    SELECT COUNT(*) as count
    FROM message m
    JOIN transaction t ON m.origin_tx_id = t.id
    JOIN block b ON t.block_id = b.id
    WHERE b.timestamp >= $1 AND b.timestamp < $2
  `;

  const ponderQuery = `
    SELECT COUNT(*) as count
    FROM ponder_message m
    JOIN ponder_transaction t ON m.origin_tx_id = t.id
    JOIN ponder_block b ON t.block_id = b.id
    WHERE b.timestamp >= $1 AND b.timestamp < $2
  `;

  try {
    const scraperResult = await pool.query(scraperQuery, [startTime, endTime]);
    const ponderResult = await pool.query(ponderQuery, [startTime, endTime]);

    console.log(`Scraper messages:      ${scraperResult.rows[0].count}`);
    console.log(`Ponder messages:       ${ponderResult.rows[0].count}`);
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error in time window comparison: ${err.message}`);
  }
}

main().catch(console.error);
