import http from 'http';
import { Registry } from 'prom-client';

import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'metrics' });

/**
 * Start a simple HTTP server to host metrics. This just takes the registry and dumps the text
 * string to people who request `GET /metrics`.
 *
 * PROMETHEUS_PORT env var is used to determine what port to host on, defaults to 9090.
 */
export function startMetricsServer(register: Registry): http.Server {
  return http
    .createServer((req, res) => {
      if (req.url != '/metrics') {
        return res.writeHead(404, 'Invalid url').end();
      }

      if (req.method != 'GET') {
        return res.writeHead(405, 'Invalid method').end();
      }

      return register
        .metrics()
        .then((metricsStr) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end(metricsStr);
        })
        .catch((err) => logger.error(err));
    })
    .listen(parseInt(process.env['PROMETHEUS_PORT'] || '9090'));
}
