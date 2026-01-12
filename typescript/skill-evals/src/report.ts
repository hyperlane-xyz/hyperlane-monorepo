/**
 * Reporting utilities for eval results.
 */
import { basename, dirname } from 'node:path';

import type { EvalReport, EvalSummary } from './types.js';

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Print a single eval report.
 */
export function printReport(
  report: EvalReport,
  verbose: boolean = false,
): void {
  const evalName = `${basename(dirname(report.eval.evalPath))}/${basename(report.eval.evalPath)}`;
  const status = report.judge.pass ? '✓' : '✗';
  const statusColor = report.judge.pass ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  console.log(`\n${statusColor}${status}${reset} ${evalName}`);
  console.log(
    `  Score: ${report.judge.score}/10 | Cost: $${report.eval.cost.toFixed(2)} + $${report.judge.judgeCost.toFixed(4)} (judge) | Duration: ${formatDuration(report.eval.durationMs)} | ${report.judge.pass ? 'PASS' : 'FAIL'}`,
  );

  if (!report.judge.pass || verbose) {
    console.log(`  Reason: ${report.judge.reasoning}`);
  }

  if (verbose) {
    console.log('\n  --- Eval Result ---');
    console.log(
      report.eval.result
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    console.log('  --- End Eval Result ---');
  }
}

/**
 * Print summary of all evals.
 */
export function printSummary(reports: EvalReport[]): void {
  const summary: EvalSummary = {
    total: reports.length,
    passed: reports.filter((r) => r.judge.pass).length,
    failed: reports.filter((r) => !r.judge.pass).length,
    totalCost: reports.reduce(
      (sum, r) => sum + r.eval.cost + r.judge.judgeCost,
      0,
    ),
    totalDurationMs: reports.reduce((sum, r) => sum + r.eval.durationMs, 0),
  };

  const statusColor = summary.failed === 0 ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  console.log('\n' + '─'.repeat(60));
  console.log(
    `${statusColor}Summary: ${summary.passed}/${summary.total} passed${reset} | Total cost: $${summary.totalCost.toFixed(2)} | Total time: ${formatDuration(summary.totalDurationMs)}`,
  );
}
