/** Observation hooks run before broadcast and before waiting for a receipt. */
export interface TransactionSubmissionOptions {
  onSubmissionAttempt?: (txHash?: string) => void | Promise<void>;
  onSubmitted?: (txHash: string) => void | Promise<void>;
}

export type TransactionSubmissionState =
  | 'not_submitted'
  | 'unknown'
  | 'submitted';

/** A transport failure is not evidence that a transaction was never sent. */
export class TransactionSubmissionError extends Error {
  constructor(
    cause: unknown,
    readonly submissionState: TransactionSubmissionState,
    readonly txHash?: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TransactionSubmissionError';
  }
}

const submissionStateOrder: Record<TransactionSubmissionState, number> = {
  not_submitted: 0,
  unknown: 1,
  submitted: 2,
};

/** Tracks one transaction through preparation, broadcast and confirmation. */
export class TransactionSubmission {
  private state: TransactionSubmissionState = 'not_submitted';
  private txHash?: string;
  private readonly observers: Required<TransactionSubmissionOptions>;

  constructor(options: TransactionSubmissionOptions = {}) {
    this.observers = {
      onSubmissionAttempt: async (txHash) => {
        // Recording failure must prevent the delegated broadcast too.
        await options.onSubmissionAttempt?.(txHash);
        if (this.state === 'not_submitted') this.state = 'unknown';
        this.txHash ??= txHash;
      },
      onSubmitted: async (txHash) => {
        this.state = 'submitted';
        this.txHash ??= txHash;
        await options.onSubmitted?.(txHash);
      },
    };
  }

  /** Pass these observers to delegated send helpers to retain their identity. */
  async run<T>(
    operation: (observers: TransactionSubmissionOptions) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(this.observers);
    } catch (error) {
      if (error instanceof TransactionSubmissionError) {
        const state =
          submissionStateOrder[this.state] >
          submissionStateOrder[error.submissionState]
            ? this.state
            : error.submissionState;
        const txHash = this.txHash ?? error.txHash;
        if (state === error.submissionState && txHash === error.txHash)
          throw error;
        throw new TransactionSubmissionError(error, state, txHash);
      }
      throw new TransactionSubmissionError(error, this.state, this.txHash);
    }
  }

  async submit<T>(
    send: () => Promise<T>,
    hashOf: (response: T) => string,
    signedTxHash?: string,
  ): Promise<T> {
    return this.run(async () => {
      // Failure to record the attempt must abort before the broadcast RPC.
      await this.observers.onSubmissionAttempt(signedTxHash);
      const response = await send();
      // Even a callback failure after this point must preserve source identity.
      await this.observers.onSubmitted(hashOf(response));
      return response;
    });
  }
}
