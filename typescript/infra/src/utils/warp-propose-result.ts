import chalk from 'chalk';

import { rootLogger } from '@hyperlane-xyz/utils';

/**
 * Outcome of attempting to propose a single warp-apply receipt file.
 *
 * - `Proposed`: the proposal was submitted on-chain (or already queued).
 * - `DryRun`: the proposal was computed but not submitted (--dry-run). Kept
 *   distinct from `Proposed` so a dry run can never masquerade as a real
 *   submission when computing the process exit code.
 * - `Skipped`: the file was genuinely out of scope — a foreign/unrecognized
 *   filename, or a `--chain-filter` exclusion. Never our work to do, so it
 *   does not fail the run.
 * - `Invalid`: the filename WAS recognized as an intended receipt, but its
 *   contents could not be resolved into a proposal (unknown chainId,
 *   unresolved/ambiguous governance safe, malformed JSON, schema failure, or a
 *   filename/body chainId mismatch). Unlike `Skipped`, this was intended
 *   governance work that failed, so it must fail the run rather than being
 *   silently omitted from a batch.
 * - `Unsupported`: the file WAS selected (parsed + passed the chain filter) but
 *   could not be proposed for a non-error reason — e.g. the proposer is not an
 *   owner of the target governance safe. This is requested-but-undone work, so
 *   it must fail the run rather than be silently ignored.
 * - `Failed`: the file was selected and an error occurred while proposing.
 */
export const ProposalResultStatus = {
  Proposed: 'proposed',
  DryRun: 'dry-run',
  Skipped: 'skipped',
  Invalid: 'invalid',
  Unsupported: 'unsupported',
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
  invalid: number;
  unsupported: number;
  skipped: number;
};

/**
 * A file is "eligible" once we selected it for proposal (parsed + passed the
 * chain filter): it ends up Proposed, DryRun, Unsupported, or Failed. Neither
 * out-of-scope `Skipped` files nor unparseable `Invalid` files were ever
 * selected, so neither counts toward `eligible` — but `Invalid` still fails
 * the run (see `computeExitCode`), since unlike `Skipped` it was intended
 * work.
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
  const invalid = statuses.filter(
    (s) => s === ProposalResultStatus.Invalid,
  ).length;
  const unsupported = statuses.filter(
    (s) => s === ProposalResultStatus.Unsupported,
  ).length;
  const skipped = statuses.filter(
    (s) => s === ProposalResultStatus.Skipped,
  ).length;

  return {
    candidate: statuses.length,
    eligible: proposed + dryRun + failed + unsupported,
    proposed,
    dryRun,
    failed,
    invalid,
    unsupported,
    skipped,
  };
}

/**
 * Compute the process exit code from the run's outcome counts.
 *
 * Fails (exit 1) when:
 * - any selected file failed (a partial success where one chain errored must
 *   not report success just because another chain was skipped), or
 * - any file was invalid (an intended-but-malformed receipt must not be
 *   silently omitted from a governance batch just because a sibling file
 *   succeeded), or
 * - any selected file was unsupported (requested governance work the proposer
 *   could not perform must not be masked by a sibling file's success), or
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
  if (counts.invalid > 0) {
    return 1;
  }
  if (counts.unsupported > 0) {
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
      `candidates=${counts.candidate} eligible=${counts.eligible} proposed=${counts.proposed} dry-run=${counts.dryRun} failed=${counts.failed} invalid=${counts.invalid} unsupported=${counts.unsupported} skipped=${counts.skipped}`,
    ),
  );
}
