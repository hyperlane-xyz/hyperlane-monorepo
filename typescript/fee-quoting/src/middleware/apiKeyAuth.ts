import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

export function createApiKeyAuth(apiKeys: Set<string>, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      logger.warn(
        { path: req.path },
        'Missing or malformed Authorization header',
      );
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const key = header.slice(7);
    if (!apiKeys.has(key)) {
      logger.warn({ path: req.path }, 'Invalid API key');
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    next();
  };
}
