// SPDX-License-Identifier: BUSL-1.1
export class WrappedError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
  }
}
