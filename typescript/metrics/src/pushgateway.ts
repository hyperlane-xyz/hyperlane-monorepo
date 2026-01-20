import type { Logger } from 'pino';
import { Pushgateway, type Registry } from 'prom-client';
import { format } from 'util';

import { rootLogger } from '@hyperlane-xyz/utils';

/**
 * Gets the push gateway if PROMETHEUS_PUSH_GATEWAY environment variable is set.
 *
 * @param register - The Prometheus registry
 * @param logger - Optional logger instance
 * @returns The Pushgateway instance or null if not configured
 */
export function getPushGateway(
  register: Registry,
  logger?: Logger,
): Pushgateway | null {
  const log = logger ?? rootLogger.child({ module: 'metrics' });
  const gatewayAddr = process.env['PROMETHEUS_PUSH_GATEWAY'];
  if (gatewayAddr) {
    return new Pushgateway(gatewayAddr, [], register);
  } else {
    log.warn(
      'Prometheus push gateway address was not defined; not publishing metrics.',
    );
    return null;
  }
}

/**
 * Submits metrics to a Prometheus push gateway.
 *
 * @param register - The Prometheus registry to submit
 * @param jobName - The job name for the metrics
 * @param options - Optional configuration
 * @param options.overwriteAllMetrics - If true, overwrites all metrics instead of adding
 * @param logger - Optional logger instance
 */
export async function submitMetrics(
  register: Registry,
  jobName: string,
  options?: { overwriteAllMetrics?: boolean },
  logger?: Logger,
): Promise<void> {
  const log = logger ?? rootLogger.child({ module: 'metrics' });
  const gateway = getPushGateway(register, log);
  if (!gateway) return;

  let resp;
  try {
    if (options?.overwriteAllMetrics) {
      resp = (await gateway.push({ jobName })).resp;
    } else {
      resp = (await gateway.pushAdd({ jobName })).resp;
    }
  } catch (e) {
    log.error('Error when pushing metrics', { error: format(e) });
    return;
  }

  const statusCode =
    typeof resp == 'object' && resp != null && 'statusCode' in resp
      ? (resp as any).statusCode
      : 'unknown';
  log.info('Prometheus metrics pushed to PushGateway', { statusCode });
}
