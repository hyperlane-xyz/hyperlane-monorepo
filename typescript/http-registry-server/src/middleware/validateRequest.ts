import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { AppConstants } from '../constants/index.js';
import { ApiError } from '../errors/ApiError.js';

export function validateQueryParams<Output extends object>(
  schema: z.ZodType<Output>,
) {
  const compiledSchema = z.compile(schema);
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = compiledSchema.safeParse(req.query);
    if (parsed.success) {
      Object.assign(req.query, parsed.data);
      next();
    } else {
      next(
        new ApiError(
          `Validation error in query parameters: ${z.prettifyError(parsed.error)}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateRequestParam<Output extends string | string[]>(
  name: string,
  schema: z.ZodType<Output>,
) {
  const compiledSchema = z.compile(schema);
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = compiledSchema.safeParse(req.params[name]);
    if (parsed.success) {
      req.params[name] = parsed.data;
      next();
    } else {
      next(
        new ApiError(
          `Validation error for param '${name}': ${z.prettifyError(parsed.error)}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateBody<Output>(schema: z.ZodType<Output>) {
  const compiledSchema = z.compile(schema);
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = compiledSchema.safeParse(req.body);
    if (parsed.success) {
      req.body = parsed.data; // Assign the parsed (and potentially transformed) body back
      next();
    } else {
      next(
        new ApiError(
          `Validation error in body: ${z.prettifyError(parsed.error)}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateQueryParam<Output>(
  name: string,
  schema: z.ZodType<Output>,
) {
  const compiledSchema = z.compile(schema);
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = compiledSchema.safeParse(req.query[name]);
    if (parsed.success) {
      Object.assign(req.query, { [name]: parsed.data });
      next();
    } else {
      next(
        new ApiError(
          `Validation error in query: ${z.prettifyError(parsed.error)}`,
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
