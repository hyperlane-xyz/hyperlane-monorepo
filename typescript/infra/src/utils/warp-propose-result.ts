import chalk from 'chalk';

import { rootLogger } from '@hyperlane-xyz/utils';

/**
 * Outcome of attempting to propose a single warp-apply receipt file.
 *
 * - `Proposed`: the proposal was submitted on-chain.
 * - `DryRun`: the proposal was computed but not submitted (--dry-run). Kept
 *   distinct from `Proposed` so a dry run can never masquerade as a real
 *   submission when computing the process exit code.
 * - `Skipped`: the file was not eligible (unparseable name, unknown chain,
 *   filtered out, or the signer is not authorized). Never counts as work done.
 * - `Failed`: the file was eligible and an error occurred while proposing.
 */
export const ProposalResultStatus = {
  Proposed: 'proposed',
  DryRun: 'dry-run',
  Skipped: 'skipped',
  Failed: 'failed',
} as const;

export type ProposalResultStatus =
  (typeof ProposalResultStatus)[keyof typeof ProposalResultStatus];

export type ResultCounts = {
  candidate: number;
  eligible: number;
  proposed: number;
  dryRun: number;
  failed: number;
  skipped: number;
};

/**
 * A file is "eligible" once we selected it for proposal (parsed + passed the
 * chain filter): it ends up Proposed, DryRun, or Failed. Skipped files were
 * never eligible.
 */
export function summarizeResults(
  statuses: ProposalResultStatus[],
): ResultCounts {
  const proposed = statuses.filter(
    (s) => s === ProposalResultStatus.Proposed,
  ).length;
  const dryRun = statuses.filter(
    (s) => s === ProposalResultStatus.DryRun,
  ).length;
  const failed = statuses.filter(
    (s) => s === ProposalResultStatus.Failed,
  ).length;
  const skipped = statuses.filter(
    (s) => s === ProposalResultStatus.Skipped,
  ).length;

  return {
    candidate: statuses.length,
    eligible: proposed + dryRun + failed,
    proposed,
    dryRun,
    failed,
    skipped,
  };
}

/**
 * Compute the process exit code from the run's outcome counts.
 *
 * Fails (exit 1) when:
 * - any eligible file failed (a partial success where one chain errored must
 *   not report success just because another chain was skipped), or
 * - there were candidate files but none were eligible (e.g. every file was
 *   skipped due to a filename/selector mismatch — silently exiting 0 would
 *   hide that nothing was proposed).
 *
 * Succeeds (exit 0) when there were no candidate files, or every eligible file
 * was proposed / dry-run without error.
 */
export function computeExitCode(counts: ResultCounts): number {
  if (counts.failed > 0) {
    return 1;
  }
  if (counts.candidate > 0 && counts.eligible === 0) {
    return 1;
  }
  return 0;
}

export function logCounts(counts: ResultCounts): void {
  rootLogger.info(chalk.bold('\n=== Summary ==='));
  rootLogger.info(
    chalk.bold(
      `candidates=${counts.candidate} eligible=${counts.eligible} proposed=${counts.proposed} dry-run=${counts.dryRun} failed=${counts.failed} skipped=${counts.skipped}`,
    ),
  );
}
