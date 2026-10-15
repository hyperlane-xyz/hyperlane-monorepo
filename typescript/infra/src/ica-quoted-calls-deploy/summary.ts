import { BigNumber, utils } from 'ethers';

import { logTable } from '../utils/log.js';

import { Adoption, ChainResult, FundsReport, IcaOutcome } from './types.js';

function amount(value: BigNumber, symbol: string | undefined): string {
  return `${Number(utils.formatEther(value)).toPrecision(4)} ${symbol ?? ''}`.trim();
}

function describeContract(contract: ChainResult['router']): string {
  if (contract === undefined) return '-';
  if (contract.action === Adoption.Deploy) return 'to deploy';
  return `adopt ${contract.address} (${contract.version})`;
}

function describeFunds(funds: FundsReport, symbol: string | undefined): string {
  return [
    `balance ${amount(funds.balance, symbol)}`,
    `expected ${amount(funds.expected, symbol)}`,
    `worst case ${amount(funds.worstCase, symbol)}`,
    `required ${amount(funds.required, symbol)}`,
    funds.shortfall.gt(0)
      ? `SHORT by ${amount(funds.shortfall, symbol)}`
      : 'ok',
  ].join(', ');
}

function describeRegistryBefore(before: ChainResult['registryBefore']): string {
  const entries = [
    ['interchainAccountRouterV3', before?.interchainAccountRouterV3],
    ['quotedCallsV3', before?.quotedCallsV3],
  ];
  return entries
    .map(([key, value]) => `${key}: ${value ?? '(absent)'}`)
    .join(', ');
}

// A peer that has no router (it failed, or it was skipped) leaves this chain's
// enrollments undone, so applying is not complete until every peer exists.
export function computeExitCode(
  results: ChainResult[],
  options: { apply: boolean },
): number {
  return results.some(
    ({ outcome, wiring }) =>
      outcome === IcaOutcome.Error ||
      (options.apply &&
        (outcome === IcaOutcome.InsufficientFunds ||
          (wiring?.awaiting.length ?? 0) > 0)),
  )
    ? 1
    : 0;
}

export function printSummary(results: ChainResult[]): void {
  const signers = new Set(results.map(({ signer }) => signer));
  const owners = new Set(results.map(({ owner }) => owner));
  console.info(`signer: ${[...signers].filter(Boolean).join(', ')}`);
  console.info(`owner: ${[...owners].filter(Boolean).join(', ')}`);
  logTable(
    results.map((result) => ({
      chain: result.chain,
      outcome: result.outcome,
      router: describeContract(result.router),
      quotedCalls: describeContract(result.quotedCalls),
      funds: result.funds
        ? result.funds.shortfall.gt(0)
          ? `short ${amount(result.funds.shortfall, result.gasSymbol)}`
          : 'ok'
        : '-',
    })),
  );
  for (const result of results) {
    const lines: string[] = [];
    if (result.skipReason)
      lines.push(`skipped: ${result.skipReason}: ${result.detail}`);
    else if (result.detail && result.outcome === IcaOutcome.Error) {
      lines.push(`error: ${result.detail}`);
    }
    for (const rejected of result.rejected) {
      lines.push(
        `not adopting ${rejected.source} ${rejected.address}: ${rejected.reason}`,
      );
    }
    for (const item of result.pending) lines.push(`todo: ${item}`);
    if (result.funds) {
      lines.push(describeFunds(result.funds, result.gasSymbol));
      for (const step of result.funds.steps) {
        lines.push(`  step ${step.name}: ${step.gas.toString()} gas`);
      }
      if (result.funds.l1FeeUnavailable) {
        lines.push('  L1 data fee unavailable: covered by the margin only');
      }
    }
    if (result.registryKeysWritten.length > 0) {
      lines.push(`registry updated: ${result.registryKeysWritten.join(', ')}`);
      lines.push(
        `  to restore, put back in the registry's ${result.chain}/addresses.yaml: ${describeRegistryBefore(result.registryBefore)}`,
      );
    }
    for (const note of result.notes) lines.push(`note: ${note}`);
    for (const problem of result.problems) lines.push(`problem: ${problem}`);
    if (lines.length === 0) continue;
    console.info(`[${result.chain}]`);
    for (const line of lines) console.info(`  ${line}`);
  }
}
