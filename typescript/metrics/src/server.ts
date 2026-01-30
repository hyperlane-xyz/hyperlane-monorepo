import http from 'http';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';

/**
 * Start a simple HTTP server to host metrics. This takes the registry and dumps the text
 * string to people who request `GET /metrics`.
 *
 * PROMETHEUS_PORT env var is used to determine what port to host on, defaults to 9090.
 *
 * @param register - The Prometheus registry to serve metrics from
 * @param logger - Optional logger instance for error logging
 * @returns The HTTP server instance
 */
export function startMetricsServer(
  register: Registry,
  logger?: Logger,
): http.Server {
  const port = parseInt(process.env['PROMETHEUS_PORT'] || '9090');
  const server = http
    .createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404, 'Invalid url').end();
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, 'Invalid method').end();
        return;
      }

      register
        .metrics()
        .then((metricsStr) => {
          res
            .writeHead(200, { 'Content-Type': register.contentType })
            .end(metricsStr);
        })
        .catch((err) => {
          if (logger) {
            logger.error(err, 'Failed to collect metrics');
          }
          res
            .writeHead(500, { 'Content-Type': 'text/plain' })
            .end('Internal Server Error');
        });
    })
    .on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger?.error(
          `Metrics server port ${port} already in use. Set PROMETHEUS_PORT to use a different port.`,
        );
      } else {
        logger?.error(err, 'Metrics server error');
      }
    })
    .listen(port);

  return server;
}
