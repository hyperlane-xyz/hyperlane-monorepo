import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function createErrorHandler(logger: Logger) {
  return (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }

    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ message: 'Internal server error' });
  };
}
