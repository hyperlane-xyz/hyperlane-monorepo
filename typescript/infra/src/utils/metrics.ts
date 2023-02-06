import http from 'http';
import { Pushgateway, Registry } from 'prom-client';
import { format } from 'util';

import { error, log } from '@hyperlane-xyz/utils';

function getPushGateway(register: Registry): Pushgateway | null {
  const gatewayAddr = process.env['PROMETHEUS_PUSH_GATEWAY'];
  if (gatewayAddr) {
    return new Pushgateway(gatewayAddr, [], register);
  } else {
    console.warn(
      'Prometheus push gateway address was not defined; not publishing metrics.',
    );
    return null;
  }
}

export async function submitMetrics(
  register: Registry,
  jobName: string,
  options?: { appendMode?: boolean },
) {
  const gateway = getPushGateway(register);
  if (!gateway) return;

  let resp;
  try {
    if (options?.appendMode) {
      resp = (await gateway.pushAdd({ jobName })).resp;
    } else {
      resp = (await gateway.push({ jobName })).resp;
    }
  } catch (e) {
    error('Error when pushing metrics', { error: format(e) });
    return;
  }

  const statusCode =
    typeof resp == 'object' && resp != null && 'statusCode' in resp
      ? (resp as any).statusCode
      : 'unknown';
  log('Prometheus metrics pushed to PushGateway', { statusCode });
}

/**
 * Start a simple HTTP server to host metrics. This just takes the registry and dumps the text
 * string to people who request `GET /metrics`.
 *
 * PROMETHEUS_PORT env var is used to determine what port ot host on, defaults to 9090.
 */
export function startMetricsServer(register: Registry): http.Server {
  return http
    .createServer((req, res) => {
      if (req.url != '/metrics') res.writeHead(404, 'Invalid url').end();
      if (req.method != 'GET') res.writeHead(405, 'Invalid method').end();

      register
        .metrics()
        .then((metricsStr) => {
          res.writeHead(200, { ContentType: 'text/plain' }).end(metricsStr);
        })
        .catch((err) => console.error(err));
    })
    .listen(parseInt(process.env['PROMETHEUS_PORT'] || '9090'));
}
