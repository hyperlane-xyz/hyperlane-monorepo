export class WrappedError extends Error {
  constructor(message: string, originalError?: Error) {
    super(message);
    this.name = 'WrappedError';

    // Preserve the stack trace of the original error if available
    if (originalError?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}
