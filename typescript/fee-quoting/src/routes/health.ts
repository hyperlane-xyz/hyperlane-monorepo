import { Router } from 'express';

export function createHealthRouter(isReady: () => boolean): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const ready = isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'starting' });
  });

  return router;
}
