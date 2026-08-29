import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { assert, fromHexString } from '@hyperlane-xyz/utils';

import { ApiError } from '../errors/ApiError.js';
import { isCanonicalBase64 } from './encoding.js';

export function validateSignerToken(token: string | undefined): string {
  assert(token, 'HYP_HTTP_SIGNER_TOKEN is required in signer mode');

  let decoded: Buffer;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(token)) {
    decoded = fromHexString(token);
  } else {
    assert(
      isCanonicalBase64(token),
      'HYP_HTTP_SIGNER_TOKEN must be hex or canonical base64',
    );
    decoded = Buffer.from(token, 'base64');
  }
  assert(
    decoded.length >= 32,
    'HYP_HTTP_SIGNER_TOKEN must contain at least 32 bytes',
  );
  return token;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function createSignerAuth(token: string) {
  const expectedDigest = tokenDigest(validateSignerToken(token));
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.get('origin')) {
      next(
        new ApiError('Browser-originated signer requests are forbidden', 403),
      );
      return;
    }
    const authorization = req.get('authorization');
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    if (!timingSafeEqual(tokenDigest(supplied), expectedDigest)) {
      next(new ApiError('Invalid or missing signer token', 401));
      return;
    }
    if (req.method === 'POST' && !req.is('application/json')) {
      next(new ApiError('Signer POST requests require application/json', 400));
      return;
    }
    next();
  };
}
