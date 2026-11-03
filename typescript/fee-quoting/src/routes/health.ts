import type { FeeQuotingApp } from '../http.js';

export function registerHealthRoute(
  app: FeeQuotingApp,
  isReady: () => boolean,
): void {
  app.get('/health', async (_request, reply) => {
    const ready = isReady();
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'starting' });
  });
}
