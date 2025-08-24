import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import { AppConstants } from '../constants/index.js';
import { ApiError } from '../errors/ApiError.js';

export function validateQueryParams<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (parsed.success) {
      Object.assign(req.query, parsed.data);
      next();
    } else {
      const validationError = fromZodError(parsed.error);
      next(
        new ApiError(
          `Validation error in query parameters: ${validationError.message}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateRequestParam<T extends z.ZodTypeAny>(
  name: string,
  schema: T,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params[name]);
    if (parsed.success) {
      req.params[name] = parsed.data;
      next();
    } else {
      const validationError = fromZodError(parsed.error);
      next(
        new ApiError(
          `Validation error for param '${name}': ${validationError.message}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (parsed.success) {
      req.body = parsed.data; // Assign the parsed (and potentially transformed) body back
      next();
    } else {
      const validationError = fromZodError(parsed.error);
      next(
        new ApiError(
          `Validation error in body: ${validationError.message}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateQueryParam<T extends z.ZodTypeAny>(
  name: string,
  schema: T,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query[name]);
    if (parsed.success) {
      req.query[name] = parsed.data;
      next();
    } else {
      const validationError = fromZodError(parsed.error);
      next(
        new ApiError(
          `Validation error in query: ${validationError.message}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function joinPathSegments(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (Array.isArray(req.params.id)) {
    // The splat route captures path segments as an array. Join them back together.
    req.params.id = req.params.id.join('/');
  }
  next();
}
