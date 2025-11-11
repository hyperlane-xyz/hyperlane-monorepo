import { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

import { AppConstants } from '../constants/AppConstants.js';
import { ApiError } from '../errors/ApiError.js';

export function createErrorHandler(logger: Logger) {
  return function errorHandler(
    err: any,
    _req: Request,
    res: Response,
    next: NextFunction,
  ) {
    // If we've already started sending a response, delegate to the default handler
    if (res.headersSent) {
      return next(err);
    }

    const apiError =
      err instanceof ApiError
        ? err
        : err instanceof Error
          ? new ApiError(
              `Internal Server Error: ${err.message}`,
              AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR,
              err.stack,
            )
          : new ApiError(
              'Internal Server Error: unknown error',
              AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR,
            );

    logger.error({ error: err }, 'Error handling request');

    res.status(apiError.status).json({
      message: apiError.message,
      stack: apiError.stack,
    });
  };
}
