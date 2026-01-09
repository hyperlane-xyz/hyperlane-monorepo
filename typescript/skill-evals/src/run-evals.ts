#!/usr/bin/env tsx
/**
 * CLI entry point for running skill evaluations.
 *
 * Usage:
 *   pnpm eval                                    # Run all evals
 *   pnpm eval --filter alert-validator          # Filter by skill name
 *   EVAL_PARALLELISM=4 pnpm eval                 # Higher parallelism
 */
import { glob } from 'glob';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import pLimit from 'p-limit';

import { judgeResult } from './judge.js';
import { runEval } from './runner.js';
import type { EvalReport, EvalSummary } from './types.js';

/** Default parallelism for running evals */
const DEFAULT_PARALLELISM = 2;

/** Path to evals directory */
const EVALS_DIR = join(import.meta.dirname, '..', 'evals');

/**
 * Parse CLI arguments.
 */
function parseArgs(): { filter?: string; single?: boolean } {
  const args = process.argv.slice(2);
  let filter: string | undefined;
  let single = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filter' && args[i + 1]) {
      filter = args[i + 1];
      i++;
    } else if (args[i] === '--single') {
      single = true;
    }
  }

  return { filter, single };
}

/**
 * Discover all eval directories.
 */
async function discoverEvals(filter?: string): Promise<string[]> {
  const pattern = filter
    ? `${EVALS_DIR}/*${filter}*/*/eval-prompt.md`
    : `${EVALS_DIR}/*/*/eval-prompt.md`;

  const promptFiles = await glob(pattern);
  return promptFiles.sort();
}

/**
 * Run a single eval and judge the result.
 */
async function runAndJudgeEval(promptPath: string): Promise<EvalReport> {
  const evalDir = dirname(promptPath);
  const expectedPath = join(evalDir, 'eval-expected.md');

  // Run the eval
  const evalResult = await runEval(promptPath);

  // Judge the result
  if (!existsSync(expectedPath)) {
    return {
      eval: evalResult,
      judge: {
        pass: false,
        reasoning: `Missing expected file: ${expectedPath}`,
        judgeCost: 0,
      },
    };
  }

  const judgeResult_ = await judgeResult(evalResult.result, expectedPath);

  return {
    eval: evalResult,
    judge: judgeResult_,
  };
}

/**
 * Format duration for display.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Print a single eval report.
 */
function printReport(report: EvalReport): void {
  const evalName = `${basename(dirname(report.eval.evalPath))}/${basename(report.eval.evalPath)}`;
  const status = report.judge.pass ? '✓' : '✗';
  const statusColor = report.judge.pass ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  console.log(`\n${statusColor}${status}${reset} ${evalName}`);
  console.log(
    `  Cost: $${report.eval.cost.toFixed(2)} + $${report.judge.judgeCost.toFixed(4)} (judge) | Duration: ${formatDuration(report.eval.durationMs)} | ${report.judge.pass ? 'PASS' : 'FAIL'}`,
  );

  if (!report.judge.pass) {
    console.log(`  Reason: ${report.judge.reasoning}`);
  }
}

/**
 * Print summary of all evals.
 */
function printSummary(reports: EvalReport[]): void {
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

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const { filter, single } = parseArgs();
  const parallelism = parseInt(
    process.env.EVAL_PARALLELISM || String(DEFAULT_PARALLELISM),
    10,
  );

  // Discover evals
  const promptPaths = await discoverEvals(filter);

  if (promptPaths.length === 0) {
    console.log('No evals found.');
    if (filter) {
      console.log(`  Filter: ${filter}`);
    }
    process.exit(0);
  }

  // If single mode, just run the first eval
  const evalsToRun = single ? [promptPaths[0]] : promptPaths;

  console.log(
    `Running ${evalsToRun.length} eval(s) with parallelism=${parallelism}...`,
  );

  // Run evals with parallelism
  const limit = pLimit(parallelism);
  const reports = await Promise.all(
    evalsToRun.map((path) => limit(() => runAndJudgeEval(path))),
  );

  // Print results
  for (const report of reports) {
    printReport(report);
  }

  // Print summary
  printSummary(reports);

  // Exit with error code if any failed
  const failedCount = reports.filter((r) => !r.judge.pass).length;
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
