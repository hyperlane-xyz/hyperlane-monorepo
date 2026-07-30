import type { NextFunction, Request, Response } from 'express';

export type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/**
 * Wrap an async route handler so its rejected promise is forwarded to
 * Express's error middleware. Express v4 doesn't auto-forward; this is the
 * standard workaround. Shared across v1 and v2 route handlers.
 */
export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
