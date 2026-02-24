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

async function probeUrl(
  url: string,
  expectedChainId: number,
): Promise<ProbeResult> {
  const provider = new ethers.providers.StaticJsonRpcProvider(url);
  const start = Date.now();
  try {
    const [block, network] = await timeout(
      Promise.all([provider.getBlock('latest'), provider.getNetwork()]),
      TIMEOUT_MS,
      `Timeout after ${TIMEOUT_MS}ms`,
    );
    const latencyMs = Date.now() - start;
    const chainIdMismatch =
      network.chainId !== expectedChainId
        ? `expected ${expectedChainId}, got ${network.chainId}`
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
    return { url, error: raw };
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
        URL: r.url,
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
      URL: r.url,
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

  const dedupedCount = allRegistryUrls.length - registryUrls.length;
  const dedupNote =
    dedupedCount > 0
      ? ` (${dedupedCount} registry URL${dedupedCount > 1 ? 's' : ''} already in private set)`
      : '';
  console.log(
    `Probing ${privateUrls.length} private + ${registryUrls.length} registry RPCs for ${chain} (${environment})...${dedupNote}`,
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
          error: String(s.reason),
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
  const registryLabel =
    registryResults.length === 0 && dedupedCount > 0
      ? `Registry RPCs (${environment} / ${chain}) — all ${dedupedCount} already in private set`
      : `Registry RPCs (${environment} / ${chain})`;
  printTable(registryLabel, registryResults, maxBlock);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
