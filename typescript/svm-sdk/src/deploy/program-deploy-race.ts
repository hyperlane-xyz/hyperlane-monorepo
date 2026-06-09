/**
 * Generic retry helpers for the race between program deploy and its first
 * post-deploy init instruction. Reusable across writers that deploy a fresh
 * program and then initialize PDA-backed state on it.
 *
 * The race: after a successful `deploy_with_max_data_len` tx, the cluster may
 * acknowledge the deploy but not yet make the program callable. The follow-up
 * init tx then fails with "Program is not deployed" or "invalid account data
 * for instruction". These two error strings are the markers for a recoverable
 * race; everything else is a real failure and is not retried.
 */

export const INIT_RETRY_ATTEMPTS = 8;
export const INIT_RETRY_BASE_MS = 1000;

export type ProgramDeploymentError = Error & {
  context?: { logs?: string[] };
  isRecoverable?: boolean;
};

export function toProgramDeploymentError(
  error: unknown,
): ProgramDeploymentError {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function isProgramDeploymentRace(error: unknown): boolean {
  const logs = toProgramDeploymentError(error).context?.logs;
  return !!logs?.some(
    (log) =>
      log.includes('Program is not deployed') ||
      log.includes('invalid account data for instruction'),
  );
}
