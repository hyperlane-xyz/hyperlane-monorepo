import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { AppConstants } from '../constants/index.js';
import { ApiError } from '../errors/ApiError.js';

interface ValidationError {
  issues: readonly {
    message: string;
    path: readonly PropertyKey[];
  }[];
}

type SafeParseSchema<Output> = {
  safeParse: (
    input: unknown,
  ) =>
    | { success: true; data: Output }
    | { success: false; error: ValidationError };
};

/** Remove after @hyperlane-xyz/registry publishes Zod 4 schemas. */
export function legacyRegistrySchema<Output>(
  schema: SafeParseSchema<Output>,
): z.ZodType<Output> {
  return z.unknown().transform((input, context) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;

    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: [...issue.path],
      });
    }
    return z.NEVER;
  });
}

function isZod4Error(error: ValidationError): error is z.ZodError {
  return error instanceof z.ZodError;
}

function formatValidationError(error: ValidationError): string {
  if (isZod4Error(error)) {
    return z.prettifyError(error);
  }

  // Registry schemas currently expose Zod 3 errors, so retain a small
  // structural fallback until the registry publishes Zod 4 schemas.
  return error.issues
    .map(({ message, path }) =>
      path.length
        ? `✖ ${message}\n  → at ${path.map(String).join('.')}`
        : `✖ ${message}`,
    )
    .join('\n');
}

export function validateQueryParams<Output extends object>(
  schema: SafeParseSchema<Output>,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (parsed.success) {
      Object.assign(req.query, parsed.data);
      next();
    } else {
      next(
        new ApiError(
          `Validation error in query parameters: ${formatValidationError(parsed.error)}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateRequestParam<Output extends string | string[]>(
  name: string,
  schema: SafeParseSchema<Output>,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params[name]);
    if (parsed.success) {
      req.params[name] = parsed.data;
      next();
    } else {
      next(
        new ApiError(
          `Validation error for param '${name}': ${formatValidationError(parsed.error)}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateBody<Output>(schema: SafeParseSchema<Output>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (parsed.success) {
      req.body = parsed.data; // Assign the parsed (and potentially transformed) body back
      next();
    } else {
      next(
        new ApiError(
          `Validation error in body: ${formatValidationError(parsed.error)}`,
          AppConstants.HTTP_STATUS_BAD_REQUEST,
        ),
      );
    }
  };
}

export function validateQueryParam<Output>(
  name: string,
  schema: SafeParseSchema<Output>,
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query[name]);
    if (parsed.success) {
      Object.assign(req.query, { [name]: parsed.data });
      next();
    } else {
      next(
        new ApiError(
          `Validation error in query: ${formatValidationError(parsed.error)}`,
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
