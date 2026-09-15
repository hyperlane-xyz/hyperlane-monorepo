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

    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const serialized = JSON.stringify(body);
      const revision = createHash('sha256')
        .update(serialized)
        .digest('base64url');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', `"sha256-${revision}"`);
      res.setHeader(REVISION_HEADER, revision);
      return sendJson(body);
    };
    next();
  };
}

function excludedPath(path: string): boolean {
  return (
    path === '/health' || path === '/readiness' || path.startsWith('/signer')
  );
}
