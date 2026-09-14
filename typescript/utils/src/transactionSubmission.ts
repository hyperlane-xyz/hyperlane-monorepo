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

/** Tracks one transaction through preparation, broadcast and confirmation. */
export class TransactionSubmission {
  private state: TransactionSubmissionState = 'not_submitted';
  private txHash?: string;

  constructor(private readonly options: TransactionSubmissionOptions = {}) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TransactionSubmissionError) throw error;
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
      await this.options.onSubmissionAttempt?.(signedTxHash);
      this.txHash = signedTxHash;
      this.state = 'unknown';
      const response = await send();
      this.txHash = hashOf(response);
      this.state = 'submitted';
      // Even a callback failure after this point must preserve source identity.
      await this.options.onSubmitted?.(this.txHash);
      return response;
    });
  }
}
