import { createHash } from 'node:crypto';

import type { RequestHandler } from 'express';

const REVISION_HEADER = 'X-Hyperlane-Registry-Content-Revision';

/** Adds strong content validation to public registry JSON reads. */
export function registryContentRevision(): RequestHandler {
  return (req, res, next) => {
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      excludedPath(req.path)
    ) {
      next();
      return;
    }

    const send = res.send.bind(res);
    res.send = (body: unknown) => {
      if (
        res.statusCode < 200 ||
        res.statusCode >= 300 ||
        !res
          .getHeader('Content-Type')
          ?.toString()
          .startsWith('application/json') ||
        (typeof body !== 'string' && !Buffer.isBuffer(body))
      ) {
        return send(body);
      }

      // Express has already applied its JSON replacer, spacing, and escaping.
      const revision = createHash('sha256').update(body).digest('base64url');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', `"sha256-${revision}"`);
      res.setHeader(REVISION_HEADER, revision);
      return send(body);
    };
    next();
  };
}

function excludedPath(path: string): boolean {
  return /^\/(?:health|readiness|signer)(?:\/|$)/i.test(path);
}
