import { ethers } from 'ethers';

import { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, timeout } from '@hyperlane-xyz/utils';

import {
  getSecretRpcEndpoints,
  secretRpcEndpointsExist,
} from '../../src/agents/index.js';
import { getChain } from '../../config/registry.js';
import { getArgs, withChainRequired } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const TIMEOUT_MS = 5_000;
const STALENESS_OK_SEC = 30;
const STALENESS_WARN_SEC = 120;

interface ProbeSuccess {
  url: string;
  blockNumber: number;
  blockTimestamp: number;
  latencyMs: number;
  chainIdMismatch?: string;
}

interface ProbeError {
  url: string;
  error: string;
}

type ProbeResult = ProbeSuccess | ProbeError;

function isProbeError(r: ProbeResult): r is ProbeError {
  return 'error' in r;
}

function healthEmoji(staleness?: number): string {
  if (staleness === undefined) return '❌';
  if (staleness < STALENESS_OK_SEC) return '✅';
  if (staleness < STALENESS_WARN_SEC) return '⚠️';
  return '❌';
}

/** Redact path segments after the host (often contain API keys). */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasPath = u.pathname.length > 1; // more than just "/"
    const hasQuery = u.search.length > 0;
    const suffix = hasPath || hasQuery ? '/<redacted>' : '/';
    return `${u.protocol}//${u.host}${suffix}`;
  } catch (err) {
    console.warn('Failed to parse URL for redaction', err);
    return '<redacted-url>';
  }
}

/** Strip the raw RPC URL from error messages to avoid leaking secrets. */
function sanitizeError(msg: string, url: string): string {
  // Replace exact URL first
  let sanitized = msg.replaceAll(url, '[REDACTED_RPC_URL]');
  // Also redact the URL without trailing slash (ethers sometimes strips it)
  const urlNoTrailingSlash = url.replace(/\/+$/, '');
  if (urlNoTrailingSlash !== url) {
    sanitized = sanitized.replaceAll(urlNoTrailingSlash, '[REDACTED_RPC_URL]');
  }
  return sanitized;
}

async function probeUrl(
  url: string,
  expectedChainId: number,
): Promise<ProbeResult> {
  const provider = new ethers.JsonRpcProvider(url);
  const start = Date.now();
  try {
    const [block, network] = await timeout(
      Promise.all([provider.getBlock('latest'), provider.getNetwork()]),
      TIMEOUT_MS,
      `Timeout after ${TIMEOUT_MS}ms`,
    );
    if (!block) {
      return { url, error: 'latest block unavailable' };
    }
    const latencyMs = Date.now() - start;
    const chainIdMismatch =
      network.chainId !== BigInt(expectedChainId)
        ? `expected ${expectedChainId}, got ${network.chainId.toString()}`
        : undefined;
    return {
      url,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      latencyMs,
      chainIdMismatch,
    };
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    return { url, error: sanitizeError(raw, url) };
  }
}

function printTable(label: string, results: ProbeResult[], maxBlock: number) {
  console.log(`\n${label}`);
  if (results.length === 0) {
    console.log('  (none)');
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const rows = results.map((r, i) => {
    if (isProbeError(r)) {
      return {
        '#': i + 1,
        URL: redactUrl(r.url),
        'Block #': '—',
        'Block Diff': '—',
        'Block Time': '—',
        Staleness: '—',
        Health: '❌',
        Latency: '—',
        Note: r.error.slice(0, 80),
      };
    }
    const staleness = nowSec - r.blockTimestamp;
    return {
      '#': i + 1,
      URL: redactUrl(r.url),
      'Block #': r.blockNumber,
      'Block Diff': maxBlock - r.blockNumber,
      'Block Time': new Date(r.blockTimestamp * 1000).toISOString(),
      Staleness: `${staleness}s`,
      Health: r.chainIdMismatch ? '❌' : healthEmoji(staleness),
      Latency: `${r.latencyMs}ms`,
      Note: r.chainIdMismatch ? `chainId: ${r.chainIdMismatch}` : '',
    };
  });

  console.table(rows);
}

async function main() {
  const { environment, chain } = await withChainRequired(getArgs()).argv;

  // EVM-only guard
  const chainMetadata = getChain(chain);
  if (chainMetadata.protocol !== ProtocolType.Ethereum) {
    console.log(
      `Skipping ${chain}: non-EVM chain (protocol=${chainMetadata.protocol})`,
    );
    process.exit(0);
  }

  assert(
    typeof chainMetadata.chainId === 'number',
    `chainMetadata.chainId must be a number, got ${typeof chainMetadata.chainId}`,
  );
  const expectedChainId = chainMetadata.chainId;

  // Fetch private RPCs
  let privateUrls: string[] = [];
  const hasSecrets = await secretRpcEndpointsExist(environment, chain);
  if (hasSecrets) {
    privateUrls = await getSecretRpcEndpoints(environment, chain);
  }

  // Fetch registry RPCs (public, no secrets)
  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry(false);
  const metadata = await registry.getChainMetadata(chain);
  assert(metadata, `No chain metadata for ${chain}`);
  const allRegistryUrls = (metadata.rpcUrls ?? []).map(
    (r: ChainMetadata['rpcUrls'][number]) => r.http,
  );

  // Deduplicate: exclude registry URLs that already appear in private set
  const privateSet = new Set(privateUrls);
  const registryUrls = allRegistryUrls.filter(
    (url: string) => !privateSet.has(url),
  );

  console.log(
    `Probing ${privateUrls.length} private + ${registryUrls.length} registry RPCs for ${chain} (${environment})...`,
  );

  // Probe all URLs concurrently
  const allUrls = [...privateUrls, ...registryUrls];
  const settled = await Promise.allSettled(
    allUrls.map((url) => probeUrl(url, expectedChainId)),
  );
  const allResults: ProbeResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          url: allUrls[i],
          error: sanitizeError(String(s.reason), allUrls[i]),
        },
  );

  const privateResults = allResults.slice(0, privateUrls.length);
  const registryResults = allResults.slice(privateUrls.length);

  // Compute max block across all successful results
  const maxBlock = allResults.reduce(
    (max, r) => (isProbeError(r) ? max : Math.max(max, r.blockNumber)),
    0,
  );

  printTable(
    `Private RPCs (${environment} / ${chain})`,
    privateResults,
    maxBlock,
  );
  printTable(
    `Registry RPCs (${environment} / ${chain})`,
    registryResults,
    maxBlock,
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
