// Backfills raw_message_dispatch.msg_body for legacy rows written before the
// column existed. Each body is recovered from the origin Mailbox Dispatch log
// and only written if keccak(message) equals the row's msg_id.
//
// Dry run (read-only credentials):
//   pnpm -C typescript/infra exec tsx scripts/scraper/backfill-raw-dispatch-bodies.ts -e testnet4
// Apply:
//   pnpm -C typescript/infra exec tsx scripts/scraper/backfill-raw-dispatch-bodies.ts -e testnet4 --apply
import postgres from 'postgres';
import {
  type PublicClient,
  createPublicClient,
  fallback,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
} from 'viem';
import yargs from 'yargs';

import { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, parseMessage, rootLogger } from '@hyperlane-xyz/utils';

import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';
import { withEnvironment } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const DISPATCH_ABI = parseAbi([
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
]);

interface NullBodyRow {
  id: string;
  origin_domain: number;
  nonce: number;
  msg_id: Buffer;
  origin_tx_hash: Buffer;
  origin_mailbox: Buffer;
  message_version: number | null;
}

interface Fix {
  id: string;
  domain: number;
  nonce: number;
  version: number;
  body: string;
}

interface Unfixable {
  id: string;
  domain: number;
  nonce: number;
  reason: string;
}

async function main() {
  const { environment, apply } = await withEnvironment(
    yargs(process.argv.slice(2)),
  )
    .boolean('apply')
    .describe('apply', 'Write the recovered bodies; dry run otherwise')
    .default('apply', false).argv;

  const logger = rootLogger.child({ module: 'backfill-raw-dispatch-bodies' });
  const registry = await getEnvironmentConfig(environment).getRegistry();
  const metadataByDomain = new Map<number, ChainMetadata>(
    Object.values(await registry.getMetadata()).map((metadata) => [
      metadata.domainId,
      metadata,
    ]),
  );

  // Dry runs never hold write credentials.
  const secret = `hyperlane-${environment}-scraper3-db${apply ? '' : '-read-only'}`;
  const sql = postgres(await fetchLatestGCPSecret(secret), { ssl: 'require' });

  try {
    const rows = await sql<NullBodyRow[]>`
      SELECT id, origin_domain, nonce, msg_id, origin_tx_hash, origin_mailbox, message_version
      FROM raw_message_dispatch
      WHERE msg_body IS NULL
      ORDER BY origin_domain, nonce
    `;
    logger.info(`Found ${rows.length} raw dispatch rows without a body`);

    const clients = new Map<number, PublicClient>();
    const fixes: Fix[] = [];
    const unfixable: Unfixable[] = [];
    for (const row of rows) {
      const metadata = metadataByDomain.get(row.origin_domain);
      if (metadata?.protocol !== ProtocolType.Ethereum) {
        unfixable.push({
          ...rowKey(row),
          reason: metadata ? `${metadata.protocol} origin` : 'unknown domain',
        });
        continue;
      }
      let client = clients.get(row.origin_domain);
      if (!client) {
        client = createPublicClient({
          transport: fallback(
            metadata.rpcUrls.map(({ http: url }) => http(url)),
          ),
        });
        clients.set(row.origin_domain, client);
      }
      try {
        fixes.push(await recoverBody(client, row));
      } catch (error) {
        unfixable.push({ ...rowKey(row), reason: String(error) });
      }
    }

    logger.info(`${apply ? 'Applying' : 'Would apply'} ${fixes.length} fixes`);
    console.table(fixes);
    if (unfixable.length > 0) {
      logger.warn(`${unfixable.length} rows could not be fixed`);
      console.table(unfixable);
    }
    if (!apply) return;

    for (const fix of fixes) {
      const updated = await sql`
        UPDATE raw_message_dispatch
        SET msg_body = ${Buffer.from(fix.body.slice(2), 'hex')},
            message_version = COALESCE(message_version, ${fix.version})
        WHERE id = ${fix.id} AND msg_body IS NULL
      `;
      if (updated.count !== 1) {
        logger.warn(
          `Row ${fix.id} was not updated; it may already have a body`,
        );
      }
    }
    logger.info('Done');
  } finally {
    await sql.end();
  }
}

async function recoverBody(
  client: PublicClient,
  row: NullBodyRow,
): Promise<Fix> {
  const msgId = toHex(row.msg_id);
  const mailbox = toHex(row.origin_mailbox.subarray(-20)).toLowerCase();
  const receipt = await client.getTransactionReceipt({
    hash: toHex(row.origin_tx_hash),
  });
  const matches = parseEventLogs({
    abi: DISPATCH_ABI,
    eventName: 'Dispatch',
    logs: receipt.logs,
  }).filter(
    (log) =>
      log.address.toLowerCase() === mailbox &&
      keccak256(log.args.message) === msgId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one Dispatch log for ${msgId} from ${mailbox}, found ${matches.length}`,
    );
  }
  const message = parseMessage(matches[0].args.message);
  if (message.nonce !== row.nonce || message.origin !== row.origin_domain) {
    throw new Error(
      `log message is nonce ${message.nonce} on ${message.origin}, row is nonce ${row.nonce} on ${row.origin_domain}`,
    );
  }
  if (row.message_version !== null && row.message_version !== message.version) {
    throw new Error(
      `log message version ${message.version} differs from row version ${row.message_version}`,
    );
  }
  return { ...rowKey(row), version: message.version, body: message.body };
}

function rowKey(row: NullBodyRow) {
  return { id: row.id, domain: row.origin_domain, nonce: row.nonce };
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
