import { expect } from 'chai';
import express, { type Request, type Response } from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

import { requestLogLevel } from '../../src/utils/http.js';

describe('request completion logging', () => {
  for (const scenario of [
    { path: '/health', status: 200, logged: false },
    { path: '/health', status: 503, logged: true },
    { path: '/health', status: 200, error: true, logged: true },
    { path: '/health?detail=1', status: 200, logged: true },
    { path: '/application', status: 200, logged: true },
  ]) {
    it(`logs=${scenario.logged} for ${scenario.path} status=${scenario.status} error=${Boolean(scenario.error)}`, async () => {
      const lines: string[] = [];
      const logger = pino({}, { write: (line: string) => lines.push(line) });
      const app = express();
      app.use(
        pinoHttp<Request, Response>({
          logger,
          customLogLevel: requestLogLevel,
        }),
      );
      const router = express.Router();
      router.get('/', (_req, res) => {
        if (scenario.error) res.err = new Error('probe failed');
        res.status(scenario.status).send('ok');
      });
      app.use('/health', router);
      app.get('/application', (_req, res) => res.status(200).send('ok'));
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected TCP server');
        const response = await fetch(
          `http://127.0.0.1:${address.port}${scenario.path}`,
        );
        expect(response.status).to.equal(scenario.status);
        await response.text();
        expect(lines).to.have.length(scenario.logged ? 1 : 0);
        if (scenario.logged) expect(lines[0]).to.include('"level":30');
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
