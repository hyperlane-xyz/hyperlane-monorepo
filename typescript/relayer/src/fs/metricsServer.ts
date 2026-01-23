import http from 'http';
import { Registry } from 'prom-client';

import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'metrics-server' });

export function startMetricsServer(register: Registry): http.Server {
  const port = parseInt(process.env['PROMETHEUS_PORT'] || '9090');

  return http
    .createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404, 'Not Found');
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405, 'Method Not Allowed');
        res.end();
        return;
      }

      register
        .metrics()
        .then((metricsStr) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(metricsStr);
        })
        .catch((err) => {
          logger.error({ err }, 'Failed to collect metrics');
          res.writeHead(500, 'Internal Server Error');
          res.end();
        });
    })
    .listen(port, () => {
      logger.info({ port }, 'Metrics server started');
    });
}
