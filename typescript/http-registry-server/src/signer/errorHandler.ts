import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

import { ApiError } from '../errors/ApiError.js';

export function createSignerErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    const knownError = error instanceof ApiError;
    const bodyTooLarge =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 413;
    logger.error(
      { errorType: error instanceof Error ? error.name : typeof error },
      'Signer request failed',
    );
    res.status(knownError ? error.status : bodyTooLarge ? 413 : 500).json({
      message: knownError
        ? error.message
        : bodyTooLarge
          ? 'Signer request body is too large'
          : 'Internal Server Error',
    });
  };
}
