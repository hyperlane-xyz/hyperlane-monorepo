#!/usr/bin/env tsx
/**
 * Compare shovel_* tables with scraper tables.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm shovel:compare
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
  shovelCount: number;
  difference: number;
  matchRate: string;
}

async function main() {
  console.log('Comparing shovel_* tables with scraper tables...\n');

  const countResults = await compareTableCounts();
  printCountResults(countResults);

  console.log('\n--- Message ID Comparison (last 1000 messages) ---\n');
  const msgComparison = await compareMessageIds(1000);
  printMessageComparison(msgComparison);

  console.log('\n--- Delivery Status Comparison ---\n');
  await compareDeliveryStatus();

  console.log('\n--- Gas Payment Comparison ---\n');
  await compareGasPayments();

  await pool.end();
}

async function compareTableCounts(): Promise<ComparisonResult[]> {
  const tables = [
    { scraper: 'block', shovel: 'shovel_block' },
    { scraper: 'transaction', shovel: 'shovel_transaction' },
    { scraper: 'message', shovel: 'shovel_message' },
    { scraper: 'delivered_message', shovel: 'shovel_delivered_message' },
    { scraper: 'gas_payment', shovel: 'shovel_gas_payment' },
    { scraper: 'raw_message_dispatch', shovel: 'shovel_raw_message_dispatch' },
  ];

  const results: ComparisonResult[] = [];

  for (const { scraper, shovel } of tables) {
    try {
      const scraperResult = await pool.query(
        `SELECT COUNT(*) as count FROM ${scraper}`,
      );
      const shovelResult = await pool.query(
        `SELECT COUNT(*) as count FROM ${shovel}`,
      );

      const scraperCount = parseInt(scraperResult.rows[0].count, 10);
      const shovelCount = parseInt(shovelResult.rows[0].count, 10);
      const difference = Math.abs(scraperCount - shovelCount);
      const matchRate =
        scraperCount > 0
          ? (
              (Math.min(scraperCount, shovelCount) / scraperCount) *
              100
            ).toFixed(2) + '%'
          : 'N/A';

      results.push({
        table: scraper,
        scraperCount,
        shovelCount,
        difference,
        matchRate,
      });
    } catch (error: unknown) {
      const err = error as Error;
      console.warn(`Error comparing ${scraper}: ${err.message}`);
      results.push({
        table: scraper,
        scraperCount: -1,
        shovelCount: -1,
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
      'Shovel'.padStart(12) +
      'Diff'.padStart(12) +
      'Match'.padStart(10),
  );
  console.log('-'.repeat(71));

  for (const r of results) {
    console.log(
      r.table.padEnd(25) +
        r.scraperCount.toString().padStart(12) +
        r.shovelCount.toString().padStart(12) +
        r.difference.toString().padStart(12) +
        r.matchRate.padStart(10),
    );
  }
}

async function compareMessageIds(
  limit: number,
): Promise<{ matching: number; scraperOnly: number; shovelOnly: number }> {
  try {
    const scraperMsgs = await pool.query(
      `
      SELECT ENCODE(msg_id, 'hex') as msg_id
      FROM message
      ORDER BY id DESC
      LIMIT $1
    `,
      [limit],
    );

    const shovelMsgs = await pool.query(
      `
      SELECT ENCODE(msg_id, 'hex') as msg_id
      FROM shovel_message
      ORDER BY id DESC
      LIMIT $1
    `,
      [limit],
    );

    const scraperSet = new Set<string>(scraperMsgs.rows.map((r) => r.msg_id));
    const shovelSet = new Set<string>(shovelMsgs.rows.map((r) => r.msg_id));

    let matching = 0;
    let scraperOnly = 0;
    let shovelOnly = 0;

    for (const msgId of scraperSet) {
      if (shovelSet.has(msgId)) {
        matching += 1;
      } else {
        scraperOnly += 1;
      }
    }

    for (const msgId of shovelSet) {
      if (!scraperSet.has(msgId)) {
        shovelOnly += 1;
      }
    }

    return { matching, scraperOnly, shovelOnly };
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error comparing message IDs: ${err.message}`);
    return { matching: 0, scraperOnly: 0, shovelOnly: 0 };
  }
}

function printMessageComparison(comparison: {
  matching: number;
  scraperOnly: number;
  shovelOnly: number;
}): void {
  console.log(`Matching messages:     ${comparison.matching}`);
  console.log(`Scraper only:          ${comparison.scraperOnly}`);
  console.log(`Shovel only:           ${comparison.shovelOnly}`);

  const total =
    comparison.matching + comparison.scraperOnly + comparison.shovelOnly;
  if (total > 0) {
    const matchRate = ((comparison.matching / total) * 100).toFixed(2);
    console.log(`\nOverall match rate:    ${matchRate}%`);
  }
}

async function compareDeliveryStatus(): Promise<void> {
  try {
    const scraperDelivered = await pool.query(
      'SELECT COUNT(*) as count FROM delivered_message',
    );
    const shovelDelivered = await pool.query(
      'SELECT COUNT(*) as count FROM shovel_delivered_message',
    );

    console.log(`Scraper delivered:     ${scraperDelivered.rows[0].count}`);
    console.log(`Shovel delivered:      ${shovelDelivered.rows[0].count}`);

    const missingInShovel = await pool.query(`
      SELECT COUNT(*) as count
      FROM delivered_message dm
      WHERE NOT EXISTS (
        SELECT 1 FROM shovel_delivered_message sdm
        WHERE sdm.msg_id = dm.msg_id
      )
    `);
    console.log(`Missing in Shovel:     ${missingInShovel.rows[0].count}`);
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error comparing deliveries: ${err.message}`);
  }
}

async function compareGasPayments(): Promise<void> {
  try {
    const scraperPayments = await pool.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(payment::numeric), 0) as total FROM gas_payment',
    );
    const shovelPayments = await pool.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(payment::numeric), 0) as total FROM shovel_gas_payment',
    );

    console.log(`Scraper payments:      ${scraperPayments.rows[0].count}`);
    console.log(`Shovel payments:       ${shovelPayments.rows[0].count}`);
    console.log(
      `Scraper total:         ${BigInt(scraperPayments.rows[0].total || 0)}`,
    );
    console.log(
      `Shovel total:          ${BigInt(shovelPayments.rows[0].total || 0)}`,
    );
  } catch (error: unknown) {
    const err = error as Error;
    console.warn(`Error comparing gas payments: ${err.message}`);
  }
}

main().catch((error) => {
  const err = error as Error;
  console.error(err.message);
  process.exit(1);
});
