import { NextFunction, Request, Response } from 'express';

import { MethodNotAllowedError } from '../errors/ApiError.js';

export function requireWriteMode(writeMode: boolean) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    if (!writeMode) {
      return next(new MethodNotAllowedError());
    }
    next();
  };
}
