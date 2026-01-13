/**
 * Types for the skill evaluation framework.
 */

/**
 * Result from running an eval through Claude Code.
 */
export interface EvalResult {
  /** Path to the eval directory */
  evalPath: string;
  /** The prompt that was sent to Claude Code */
  prompt: string;
  /** Claude Code's final result */
  result: string;
  /** Total cost in USD for the Claude Code execution */
  cost: number;
  /** Duration of the eval run in milliseconds */
  durationMs: number;
}

/**
 * Result from the Haiku judge evaluating an eval result.
 */
export interface JudgeResult {
  /** Whether the eval passed the judge's evaluation (score >= 8) */
  pass: boolean;
  /** Score from 1-10 evaluating the quality of the result */
  score: number;
  /** The judge's reasoning for the score */
  reasoning: string;
  /** Cost in USD for the judge API call */
  judgeCost: number;
}

/**
 * Combined report for a single eval.
 */
export interface EvalReport {
  /** The eval execution result */
  eval: EvalResult;
  /** The judge's evaluation result */
  judge: JudgeResult;
}

/**
 * Summary statistics for an eval run.
 */
export interface EvalSummary {
  /** Total number of evals run */
  total: number;
  /** Number of evals that passed */
  passed: number;
  /** Number of evals that failed */
  failed: number;
  /** Total cost in USD (eval + judge) */
  totalCost: number;
  /** Total duration in milliseconds */
  totalDurationMs: number;
}
