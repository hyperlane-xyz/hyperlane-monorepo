import { expect } from 'chai';
import Fastify, { LogController } from 'fastify';
import { pino } from 'pino';

import { CCIP_ROUTER_OPTIONS, type CcipApp } from '../../src/http.js';
import { registerRequestLogging } from '../../src/utils/http.js';

describe('request completion logging', () => {
  for (const scenario of [
    { path: '/health', status: 200, logged: false },
    { path: '/health/', status: 200, logged: true },
    { path: '/Health', status: 200, logged: true },
    { path: '/health', status: 503, logged: true },
    { path: '/health', status: 500, error: true, logged: true },
    { path: '/health?detail=1', status: 200, logged: true },
    { path: '/application', status: 200, logged: true },
  ]) {
    it(`logs=${scenario.logged} for ${scenario.path} status=${scenario.status} error=${Boolean(scenario.error)}`, async () => {
      const lines: string[] = [];
      const logger = pino({}, { write: (line: string) => lines.push(line) });
      const app: CcipApp = Fastify({
        logController: new LogController({ disableRequestLogging: true }),
        loggerInstance: logger,
        routerOptions: CCIP_ROUTER_OPTIONS,
      });
      registerRequestLogging(app);
      app.setErrorHandler(async (_error, _request, reply) => {
        return reply.code(500).send('failed');
      });
      app.get('/health', async (_request, reply) => {
        if (scenario.error) throw new Error('probe failed');
        return reply.code(scenario.status).send('ok');
      });
      app.get('/application', async (_request, reply) =>
        reply.code(200).send('ok'),
      );
      await app.ready();
      try {
        const response = await app.inject({
          method: 'GET',
          url: scenario.path,
        });
        expect(response.statusCode).to.equal(scenario.status);
        expect(lines).to.have.length(scenario.logged ? 1 : 0);
        if (scenario.logged) {
          expect(lines[0]).to.include('"level":30');
          expect(lines[0]).to.match(/"responseTime":\d/);
          if (scenario.error)
            expect(lines[0]).to.include('"message":"probe failed"');
        }
      } finally {
        await app.close();
      }
    });
  }
});
