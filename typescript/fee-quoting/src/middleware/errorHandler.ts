import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import {
  NO_QUOTE_AVAILABLE_ERROR,
  type NoQuoteAvailableError as NoQuoteAvailableErrorBody,
  NoQuoteAvailableReason,
} from '@hyperlane-xyz/sdk';

/**
 * Base class for HTTP errors thrown by route handlers. Subclasses override
 * `toBody()` when they need to emit a custom JSON shape; the default body is
 * `{ message }`. The error handler dispatches uniformly on `ApiError` and
 * never has to learn about new subclasses.
 */
export class ApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }

  toBody(): unknown {
    return { message: this.message };
  }
}

/**
 * Thrown when the server cannot produce a quote for the requested route — the
 * configured quoter doesn't exist, hasn't been upgraded to offchain quoting,
 * or doesn't whitelist this server's signer key. Serialized to a 404 with the
 * v2 `NoQuoteAvailableError` JSON body.
 */
export class NoQuoteAvailableError extends ApiError {
  readonly reason: NoQuoteAvailableReason;
  readonly detail: string;

  constructor(reason: NoQuoteAvailableReason, detail: string) {
    super(detail, 404);
    this.reason = reason;
    this.detail = detail;
  }

  override toBody(): NoQuoteAvailableErrorBody {
    return {
      error: NO_QUOTE_AVAILABLE_ERROR,
      reason: this.reason,
      detail: this.detail,
    };
  }
}

export function createErrorHandler(logger: Logger) {
  return (err: Error, _request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(err.toBody());
    }

    logger.error({ err }, 'Unhandled error');
    return reply.code(500).send({ message: 'Internal server error' });
  };
}
