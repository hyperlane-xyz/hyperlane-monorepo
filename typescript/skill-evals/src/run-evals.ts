#!/usr/bin/env tsx
/**
 * CLI entry point for running skill evaluations.
 *
 * Usage:
 *   pnpm eval                      # Run all evals
 *   EVAL_PARALLELISM=4 pnpm eval   # Higher parallelism
 */
import { glob } from 'glob';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';

import { judgeResult } from './judge.js';
import { printReport, printSummary } from './report.js';
import { runEval } from './runner.js';
import type { EvalReport } from './types.js';

/** Default parallelism for running evals */
const DEFAULT_PARALLELISM = 2;

/** Path to evals directory */
const EVALS_DIR = join(import.meta.dirname, '..', 'evals');

/**
 * Discover all eval directories.
 */
async function discoverEvals(): Promise<string[]> {
  const pattern = `${EVALS_DIR}/*/*/eval-prompt.md`;
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
 * Main entry point.
 */
async function main(): Promise<void> {
  const parallelism = parseInt(
    process.env.EVAL_PARALLELISM || String(DEFAULT_PARALLELISM),
    10,
  );

  // Discover evals
  const promptPaths = await discoverEvals();

  if (promptPaths.length === 0) {
    console.log('No evals found.');
    process.exit(0);
  }

  console.log(
    `Running ${promptPaths.length} eval(s) with parallelism=${parallelism}...`,
  );

  // Run evals with parallelism
  const limit = pLimit(parallelism);
  const reports = await Promise.all(
    promptPaths.map((path) => limit(() => runAndJudgeEval(path))),
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
