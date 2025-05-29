import http from 'http';
import { Gauge, Registry } from 'prom-client';

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

export function getWalletBalanceGauge(
  register: Registry,
  additionalLabels: string[] = [],
) {
  return new Gauge({
    // Mirror the rust/main/ethers-prometheus `wallet_balance` gauge metric.
    name: 'hyperlane_wallet_balance',
    help: 'Current balance of a wallet for a token',
    registers: [register],
    labelNames: [
      'chain',
      'wallet_address',
      'wallet_name',
      'token_address',
      'token_symbol',
      'token_name',
      ...additionalLabels,
    ],
  });
}
