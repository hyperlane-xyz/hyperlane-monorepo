#!/usr/bin/env tsx
/**
 * CLI entry point for running skill evaluations.
 *
 * Usage:
 *   pnpm eval                                    # Run all evals
 *   pnpm eval --filter alert-validator           # Filter by regex
 *   pnpm eval -f "skill/eval-name" --verbose     # Filter and show full output
 *   pnpm eval --concurrency 4                    # Higher concurrency
 */
import { glob } from 'glob';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import pLimit from 'p-limit';
import yargs from 'yargs';

import { judgeResult } from './judge.js';
import { printReport, printSummary } from './report.js';
import { runEval } from './runner.js';
import type { EvalReport } from './types.js';

/** Path to evals directory */
const EVALS_DIR = join(import.meta.dirname, '..', 'evals');

/**
 * Parse CLI arguments.
 */
function getArgs() {
  return yargs(process.argv.slice(2))
    .option('filter', {
      type: 'string',
      describe:
        'Regex pattern to filter eval names (e.g., "alert-.*" or "skill/eval-name")',
      alias: 'f',
    })
    .option('verbose', {
      type: 'boolean',
      describe: 'Output full eval result and judge reasoning',
      default: false,
      alias: 'v',
    })
    .option('concurrency', {
      type: 'number',
      describe: 'Number of evals to run in parallel',
      default: 2,
      alias: 'c',
    })
    .help();
}

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
async function runAndJudgeEval(
  promptPath: string,
  verbose: boolean,
): Promise<EvalReport> {
  const evalDir = dirname(promptPath);
  const expectedPath = join(evalDir, 'eval-expected.md');

  // Run the eval
  const evalResult = await runEval(promptPath, verbose);

  // Judge the result
  if (!existsSync(expectedPath)) {
    return {
      eval: evalResult,
      judge: {
        pass: false,
        score: 0,
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
 * Get eval name from prompt path (e.g., "skill-name/eval-name").
 */
function getEvalName(promptPath: string): string {
  const evalDir = dirname(promptPath);
  return `${basename(dirname(evalDir))}/${basename(evalDir)}`;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const { filter, verbose, concurrency } = await getArgs().argv;

  // Discover evals
  let promptPaths = await discoverEvals();

  // Apply filter if provided
  if (filter) {
    const filterRegex = new RegExp(filter);
    promptPaths = promptPaths.filter((path) =>
      filterRegex.test(getEvalName(path)),
    );
  }

  if (promptPaths.length === 0) {
    console.log(
      filter ? `No evals matching filter "${filter}".` : 'No evals found.',
    );
    process.exit(0);
  }

  console.log(
    `Running ${promptPaths.length} eval(s) with concurrency=${concurrency}...`,
  );

  // Run evals with concurrency
  const limit = pLimit(concurrency);
  const reports = await Promise.all(
    promptPaths.map((path) => limit(() => runAndJudgeEval(path, verbose))),
  );

  // Print results
  for (const report of reports) {
    printReport(report, verbose);
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
