#!/usr/bin/env tsx
/**
 * Local JSON-RPC proxy for testing validator quorum disagreement handling.
 *
 * Proxies every request to a real upstream RPC unchanged, EXCEPT eth_call
 * requests whose calldata is the latestCheckpoint() selector (0x907c0f92) --
 * those get a deliberately wrong (but validly ABI-encoded) (root, index)
 * response instead of being forwarded. The wrong root/index are derived from
 * a seed, so distinct seeds across instances produce distinct wrong values
 * (genuine disagreement) while the same seed reproduces the same values.
 *
 * Usage (from typescript/infra/):
 *   pnpm tsx scripts/rpc/mock-disagree-rpc.ts --rpc https://ethereum.publicnode.com --port 8899
 *   pnpm tsx scripts/rpc/mock-disagree-rpc.ts --rpc <url> --port 8900 --seed my-fixed-seed
 *
 * Then point one of your additionalQuorumRpcUrls entries at http://127.0.0.1:<port>.
 *
 * IMPORTANT: if running multiple instances to simulate multiple disagreeing
 * providers, let each pick its own random seed (default) or pass distinct
 * --seed values. Instances sharing a seed produce identical wrong values and
 * can form a false majority against the honest provider, instead of
 * triggering genuine disagreement.
 */
import { createHash, randomBytes } from 'crypto';
import http from 'http';
import yargs from 'yargs';

import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'mock-disagree-rpc' });

const LATEST_CHECKPOINT_SELECTOR = '907c0f92';

function fakeCheckpoint(seed: string): { root: string; index: number } {
  const digest = createHash('sha256').update(seed).digest();
  const root = digest.toString('hex');
  // Keep the index in a plausible (< 2^24) range rather than a full u32.
  const index = digest.readUInt32BE(4) >>> 8;
  return { root, index };
}

function encodeCheckpointResult(root: string, index: number): string {
  return '0x' + root + index.toString(16).padStart(64, '0');
}

// Upstream RPC URLs commonly embed API keys; only ever log the host, not the
// full URL (which is still visible to the operator via --rpc itself).
function redactedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

async function forward(upstream: string, body: Buffer): Promise<Buffer> {
  const res = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body.toString(),
  });
  return Buffer.from(await res.arrayBuffer());
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface JsonRpcRequest {
  id: unknown;
  method: string;
  params?: Array<{ data?: string }>;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    typeof value.method === 'string'
  );
}

async function main() {
  const { rpc, port, seed } = await yargs(process.argv.slice(2))
    .option('rpc', {
      type: 'string',
      describe: 'upstream RPC URL to proxy',
      demandOption: true,
    })
    .option('port', {
      type: 'number',
      describe: 'local port to listen on',
      default: 8899,
    })
    .option('seed', {
      type: 'string',
      describe:
        'seed for the spoofed (root, index) pair; random if unset so each instance disagrees independently',
    })
    .parseAsync();

  const effectiveSeed = seed ?? randomBytes(16).toString('hex');
  const { root, index } = fakeCheckpoint(effectiveSeed);

  logger.info(
    { port, upstreamHost: redactedHost(rpc), seed: effectiveSeed, root, index },
    'mock disagreeing RPC starting; latestCheckpoint() calls will be spoofed',
  );

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString());
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (!isJsonRpcRequest(parsed)) {
      res.writeHead(400);
      res.end();
      return;
    }

    const call = parsed.params?.[0];
    const data = (call?.data ?? '').toLowerCase().replace('0x', '');
    if (
      parsed.method === 'eth_call' &&
      data.startsWith(LATEST_CHECKPOINT_SELECTOR)
    ) {
      const result = encodeCheckpointResult(root, index);
      logger.info(
        { result },
        'intercepted latestCheckpoint() -> spoofed wrong value',
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
      return;
    }

    try {
      const upstreamRes = await forward(rpc, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(upstreamRes);
    } catch (e) {
      logger.error({ err: e }, 'upstream request failed');
      res.writeHead(502);
      res.end();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(
      `listening on http://127.0.0.1:${port} -> proxying ${redactedHost(rpc)}`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
