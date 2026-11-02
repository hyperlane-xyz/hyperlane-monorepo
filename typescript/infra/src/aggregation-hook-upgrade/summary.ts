import { ChainName } from '@hyperlane-xyz/sdk';

import { logTable } from '../utils/log.js';

import { ChainOutcome, ChainResult } from './types.js';

interface SummaryRow {
  chain: ChainName;
  outcome: string;
  detail: string;
  factory: string;
  aggregators: string;
  domains: string;
  setHooks: string;
  shadowRoutingHook: string;
  owner: string;
}

function toSummaryRow(result: ChainResult): SummaryRow {
  let factoryState = '-';
  if (result.factory) {
    if (result.factory.address === undefined) factoryState = 'to deploy';
    else if (result.factory.deployed) factoryState = 'deployed';
    else factoryState = result.factory.previous ? 'adopted' : 'kept';
  }
  const coverage = result.coverage;
  return {
    chain: result.chain,
    outcome: result.outcome,
    detail: result.skipReason
      ? `${result.skipReason}: ${result.detail ?? ''}`
      : (result.detail ?? result.pending.join('; ')),
    factory: `${factoryState} ${result.factory?.address ?? '-'}`,
    aggregators: `${result.aggregators.filter((a) => a.deployed).length}/${result.aggregators.length} deployed`,
    domains: coverage
      ? `${coverage.legacy} legacy, ${coverage.fixed} fixed, ${coverage.unmapped.length} unmapped, ${coverage.nonAggregation.length} non-agg, ${coverage.ignoredMapped} ignored (${coverage.ignoredLegacy} legacy)`
      : '-',
    setHooks: result.setHooks
      ? `${result.setHooks.sent} sent, ${result.setHooks.emitted} emitted of ${result.setHooks.migrate}`
      : '-',
    shadowRoutingHook: result.shadowRoutingHook ?? '-',
    owner: result.owner
      ? `${result.owner} (${result.ownerType ?? 'UNKNOWN'})`
      : '-',
  };
}

export const FORK_LABEL =
  'FORK ONLY: address exists on a local fork, not on the real chain';

export function shadowSnippets(
  results: ChainResult[],
  options: { fork?: boolean } = {},
): string[] {
  const label = options.fork ? `# ${FORK_LABEL}\n` : '';
  return results
    .filter((result) => result.shadowRoutingHook !== undefined)
    .map(
      (result) =>
        `${label}# ${result.chain}: warp deploy.yaml\nhook: "${result.shadowRoutingHook}"`,
    );
}

export function computeExitCode(
  results: ChainResult[],
  requestedChains: ChainName[] | undefined,
): number {
  if (results.some((result) => result.outcome === ChainOutcome.Error)) return 1;
  if (!requestedChains) return 0;
  const requested = new Set(requestedChains);
  return results.some(
    (result) =>
      requested.has(result.chain) && result.outcome === ChainOutcome.Skipped,
  )
    ? 1
    : 0;
}

export function printSummary(
  results: ChainResult[],
  options: { fork?: boolean } = {},
): void {
  logTable(results.map(toSummaryRow));
  for (const result of results) {
    const coverage = result.coverage;
    if (!coverage) continue;
    if (coverage.unmapped.length > 0) {
      console.info(
        `[${result.chain}] supported chains using the fallback hook (unmapped): ${coverage.unmapped.join(', ')}`,
      );
    }
    if (coverage.nonAggregation.length > 0) {
      console.info(
        `[${result.chain}] supported chains mapped to non-aggregation hooks: ${coverage.nonAggregation
          .map((route) => `${route.chain} (${route.hook})`)
          .join(', ')}`,
      );
    }
    if (result.txFile) {
      console.info(
        `[${result.chain}] owner transactions written to ${result.txFile}`,
      );
    }
    for (const file of result.verificationRecoveryFiles) {
      console.info(
        `[${result.chain}] unpersisted verification inputs saved to ${file}; merge them into the module verification.json or pass the file to scripts/verify.ts`,
      );
    }
  }
  const snippets = shadowSnippets(results, options);
  for (const snippet of snippets) console.info(snippet);
  if (snippets.length > 0) {
    console.info(
      'Shadow routing hooks only route the supported chains; any other destination uses the fallback hook, unlike the production routing hook.',
    );
  }
}
