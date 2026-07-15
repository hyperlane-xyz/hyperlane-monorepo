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
 * @param options.overwriteAllMetrics - If true, overwrites the whole group (PUT)
 *   instead of only replacing same-named metrics (POST). Only meaningful for a
 *   single-series-per-group layout; do not use it to clear unobserved series.
 * @param options.groupings - Extra grouping labels appended to the PushGateway
 *   group key. When each series is pushed under its own grouping, it can be
 *   cleared independently via deleteMetrics without touching other series.
 * @param logger - Optional logger instance
 */
export async function submitMetrics(
  register: Registry,
  jobName: string,
  options?: {
    overwriteAllMetrics?: boolean;
    groupings?: Record<string, string>;
  },
  logger?: Logger,
): Promise<void> {
  const log = logger ?? rootLogger.child({ module: 'metrics' });
  const gateway = getPushGateway(register, log);
  if (!gateway) return;

  const params = { jobName, groupings: options?.groupings };

  let resp;
  try {
    if (options?.overwriteAllMetrics) {
      resp = (await gateway.push(params)).resp;
    } else {
      resp = (await gateway.pushAdd(params)).resp;
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

/**
 * Deletes a metric group from the Prometheus push gateway (DELETE). This is the
 * only way to clear a series: PushGateway retains the last pushed sample until
 * its group is explicitly deleted. Pass the same groupings used when the series
 * was pushed so exactly that group is removed and no other series is affected.
 *
 * @param register - The Prometheus registry (used only to resolve the gateway)
 * @param jobName - The job name the metrics were pushed under
 * @param groupings - Grouping labels identifying the group to delete
 * @param logger - Optional logger instance
 */
export async function deleteMetrics(
  register: Registry,
  jobName: string,
  groupings?: Record<string, string>,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? rootLogger.child({ module: 'metrics' });
  const gateway = getPushGateway(register, log);
  if (!gateway) return;

  let resp;
  try {
    resp = (await gateway.delete({ jobName, groupings })).resp;
  } catch (e) {
    log.error('Error when deleting metrics', { error: format(e) });
    return;
  }

  const statusCode =
    typeof resp == 'object' && resp != null && 'statusCode' in resp
      ? (resp as any).statusCode
      : 'unknown';
  log.info('Prometheus metrics deleted from PushGateway', {
    jobName,
    groupings,
    statusCode,
  });
}
