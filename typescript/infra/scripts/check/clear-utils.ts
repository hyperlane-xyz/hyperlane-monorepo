import { Pushgateway, Registry } from 'prom-client';

import { assert } from '@hyperlane-xyz/utils';

// Shared PushGateway delete helper for the clear-* scripts.
//
// The library `deleteMetrics` swallows every gateway error (and any non-2xx
// status) and resolves void, so a caller cannot tell a real delete from a
// failed one — a wedged gateway would leave stale series firing while the
// script reports success. These clears are one-shot cleanups whose whole point
// is a verified removal, so this helper instead throws unless the gateway
// confirms the delete with a 2xx status. Callers must let the throw propagate
// (or record the failure) so the process exits non-zero.

// Finite request timeout so a dead/wedged PushGateway makes the delete fail fast
// instead of hanging the one-shot clear forever. prom-client applies this
// constructor timeout to delete() too. `getPushGateway` from @hyperlane-xyz/metrics
// hardcodes no timeout, so the default gateway is built directly here.
const PUSHGATEWAY_TIMEOUT_MS = 30_000;

// The subset of prom-client's Pushgateway we depend on. Declared here (rather
// than typing against the concrete class) so tests can inject a stub and
// exercise every branch — missing config, network rejection, non-2xx, 2xx —
// without a live gateway.
export interface DeletableGateway {
  delete(params: {
    jobName: string;
    groupings: Record<string, string>;
  }): Promise<{ resp?: unknown }>;
}

function hasStatusCode(x: unknown): x is { statusCode: unknown } {
  return typeof x === 'object' && x !== null && 'statusCode' in x;
}

// Resolve the real PushGateway from PROMETHEUS_PUSH_GATEWAY, with a finite
// request timeout. Returns null when unset so the caller's assert can fail
// loudly rather than silently reporting a clear that never happened.
function defaultPushGateway(): DeletableGateway | null {
  const addr = process.env['PROMETHEUS_PUSH_GATEWAY'];
  if (!addr) {
    return null;
  }
  return new Pushgateway(
    addr,
    { timeout: PUSHGATEWAY_TIMEOUT_MS },
    new Registry(),
  );
}

export async function deleteViolationSeriesOrThrow(
  jobName: string,
  groupings: Record<string, string>,
  gateway: DeletableGateway | null = defaultPushGateway(),
): Promise<void> {
  assert(
    gateway,
    'PushGateway not configured (set PROMETHEUS_PUSH_GATEWAY); refusing to report a clear that did not happen',
  );

  const { resp } = await gateway.delete({ jobName, groupings });
  const statusCode = hasStatusCode(resp) ? resp.statusCode : undefined;

  assert(
    typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300,
    `PushGateway DELETE for ${JSON.stringify(groupings)} did not succeed (status=${String(
      statusCode,
    )})`,
  );
}
