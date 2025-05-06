import http from 'http';
import { Gauge, Pushgateway, Registry } from 'prom-client';
import { format } from 'util';

import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'metrics' });

function getPushGateway(register: Registry): Pushgateway | null {
  const gatewayAddr = process.env['PROMETHEUS_PUSH_GATEWAY'];
  if (gatewayAddr) {
    return new Pushgateway(gatewayAddr, [], register);
  } else {
    logger.warn(
      'Prometheus push gateway address was not defined; not publishing metrics.',
    );
    return null;
  }
}

export async function submitMetrics(
  register: Registry,
  jobName: string,
  options?: { overwriteAllMetrics?: boolean },
) {
  const gateway = getPushGateway(register);
  if (!gateway) return;

  let resp;
  try {
    if (options?.overwriteAllMetrics) {
      resp = (await gateway.push({ jobName })).resp;
    } else {
      resp = (await gateway.pushAdd({ jobName })).resp;
    }
  } catch (e) {
    logger.error('Error when pushing metrics', { error: format(e) });
    return;
  }

  const statusCode =
    typeof resp == 'object' && resp != null && 'statusCode' in resp
      ? (resp as any).statusCode
      : 'unknown';
  logger.info('Prometheus metrics pushed to PushGateway', { statusCode });
}

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
